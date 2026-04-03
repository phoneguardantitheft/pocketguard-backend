import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Firebase Admin / Firestore ----------
function loadFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (error) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", error);
      process.exit(1);
    }
  }

  const serviceAccountPath = "./serviceAccountKey.json";

  if (!fs.existsSync(serviceAccountPath)) {
    console.error(
      "Missing Firebase credentials. Provide FIREBASE_SERVICE_ACCOUNT_JSON or serviceAccountKey.json."
    );
    process.exit(1);
  }

  try {
    return JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  } catch (error) {
    console.error("Failed to read serviceAccountKey.json:", error);
    process.exit(1);
  }
}

const serviceAccount = loadFirebaseServiceAccount();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const linkedBanksCollection = db.collection("plaid_linked_banks");
const plaidItemStateCollection = db.collection("plaid_item_state");

// ---------- Plaid client ----------
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || "sandbox";
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI;
const PORT = process.env.PORT || 3000;

// ---------- Apple Universal Links ----------
const APPLE_TEAM_ID = "D3F59C27PJ";
const IOS_BUNDLE_ID = "com.daveonhawthorne.PocketGuard";

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error("Missing PLAID_CLIENT_ID or PLAID_SECRET in env.");
  process.exit(1);
}

if (!PLAID_REDIRECT_URI) {
  console.error("Missing PLAID_REDIRECT_URI in env.");
  process.exit(1);
}

if (!PlaidEnvironments[PLAID_ENV]) {
  console.error(`Invalid PLAID_ENV value: ${PLAID_ENV}`);
  process.exit(1);
}

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
      "PLAID-SECRET": PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

// ---------- Helpers ----------
function getPlaidErrorData(err) {
  return err?.response?.data || err;
}

function normalizeInstitutionName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function dedupeAccounts(accounts) {
  const seen = new Set();

  return accounts.filter((acct) => {
    const key = acct.account_id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeTransactions(transactions) {
  const seen = new Set();

  return transactions.filter((txn) => {
    const key = txn.transaction_id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function itemStateDocId(deviceId, itemId) {
  return `${deviceId}__${itemId}`;
}

function sortTransactionsNewestFirst(transactions) {
  return [...transactions].sort((a, b) => {
    const aDate = new Date(a.date || 0).getTime();
    const bDate = new Date(b.date || 0).getTime();
    return bDate - aDate;
  });
}

function mergeTransactions(existingTransactions, added, modified, removed) {
  const byId = new Map();

  for (const txn of existingTransactions || []) {
    if (txn?.transaction_id) {
      byId.set(txn.transaction_id, txn);
    }
  }

  for (const txn of added || []) {
    if (txn?.transaction_id) {
      byId.set(txn.transaction_id, txn);
    }
  }

  for (const txn of modified || []) {
    if (txn?.transaction_id) {
      byId.set(txn.transaction_id, txn);
    }
  }

  for (const removedTxn of removed || []) {
    if (removedTxn?.transaction_id) {
      byId.delete(removedTxn.transaction_id);
    }
  }

  return sortTransactionsNewestFirst(Array.from(byId.values()));
}

async function fetchTransactionsSyncPage(access_token, cursor) {
  const response = await plaidClient.transactionsSync({
    access_token,
    cursor: cursor || undefined,
    count: 500,
  });

  return response.data;
}

async function fetchTransactionsSyncAll(access_token, startingCursor = null) {
  let cursor = startingCursor || null;
  let added = [];
  let modified = [];
  let removed = [];
  let hasMore = true;
  let finalCursor = cursor;

  while (hasMore) {
    const data = await fetchTransactionsSyncPage(access_token, cursor);

    added.push(...(data.added || []));
    modified.push(...(data.modified || []));
    removed.push(...(data.removed || []));

    hasMore = data.has_more;
    cursor = data.next_cursor;
    finalCursor = data.next_cursor;
  }

  return {
    added,
    modified,
    removed,
    next_cursor: finalCursor,
  };
}

async function fetchTransactionsSyncAllWithRetry(access_token, startingCursor = null, maxAttempts = 3) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      return await fetchTransactionsSyncAll(access_token, startingCursor);
    } catch (err) {
      const data = getPlaidErrorData(err);
      const errorCode = data?.error_code || "";

      if (errorCode !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
        throw err;
      }

      attempt += 1;

      if (attempt >= maxAttempts) {
        throw err;
      }

      console.warn(
        `transactionsSync mutation during pagination, retrying (${attempt}/${maxAttempts})`
      );
    }
  }

  throw new Error("transactionsSync retry exhausted");
}

async function fetchFreshAccounts(access_token, institution_name, item_id) {
  try {
    const balanceResp = await plaidClient.accountsBalanceGet({
      access_token,
    });

    console.log(
      `[refresh] balances refreshed item=${institution_name} itemId=${item_id} accounts=${balanceResp.data.accounts.length}`
    );

    return {
      accounts: balanceResp.data.accounts || [],
      liveBalanceRefreshSucceeded: true,
    };
  } catch (balanceErr) {
    console.warn(
      `[refresh] accountsBalanceGet failed for item=${institution_name} itemId=${item_id}, falling back to accountsGet:`,
      getPlaidErrorData(balanceErr)
    );

    const accountsResp = await plaidClient.accountsGet({
      access_token,
    });

    return {
      accounts: accountsResp.data.accounts || [],
      liveBalanceRefreshSucceeded: false,
    };
  }
}

// ---------- Firestore helpers ----------
async function getLinkedItems(deviceId) {
  const doc = await linkedBanksCollection.doc(deviceId).get();
  if (!doc.exists) return [];

  const data = doc.data() || {};
  return Array.isArray(data.items) ? data.items : [];
}

async function setLinkedItems(deviceId, items) {
  await linkedBanksCollection.doc(deviceId).set(
    {
      items,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function clearLinkedItems(deviceId) {
  await linkedBanksCollection.doc(deviceId).delete();
}

async function getItemState(deviceId, itemId) {
  const docId = itemStateDocId(deviceId, itemId);
  const doc = await plaidItemStateCollection.doc(docId).get();

  if (!doc.exists) {
    return {
      cursor: null,
      transactions: [],
    };
  }

  const data = doc.data() || {};
  return {
    cursor: data.cursor || null,
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
  };
}

async function setItemState(deviceId, itemId, state) {
  const docId = itemStateDocId(deviceId, itemId);

  await plaidItemStateCollection.doc(docId).set(
    {
      cursor: state.cursor || null,
      transactions: state.transactions || [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function clearItemState(deviceId, itemId) {
  const docId = itemStateDocId(deviceId, itemId);
  await plaidItemStateCollection.doc(docId).delete();
}

// ---------- Health ----------
app.get("/health", async (req, res) => {
  try {
    await db.listCollections();
    res.json({
      ok: true,
      firestore: true,
      env: PLAID_ENV,
    });
  } catch (error) {
    console.error("health error:", error);
    res.status(500).json({
      ok: false,
      firestore: false,
    });
  }
});

// ---------- OAuth Redirect ----------
app.get("/plaid/oauth", (req, res) => {
  console.log("Plaid OAuth redirect received:", req.query);

  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;margin-top:50px;">
        <h2>PocketGuard</h2>
        <p>Bank authentication completed.</p>
        <p>You can now return to the PocketGuard app.</p>
      </body>
    </html>
  `);
});

// ---------- Apple App Site Association ----------
const appleAssociation = {
  applinks: {
    details: [
      {
        appIDs: [`${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`],
        components: [
          {
            "/": "/plaid/oauth*",
          },
        ],
      },
    ],
  },
};

app.get("/.well-known/apple-app-site-association", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(appleAssociation));
});

app.get("/apple-app-site-association", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(appleAssociation));
});

// ---------- 1) Create Link Token ----------
app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: deviceId },
      client_name: "PocketGuard",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: PLAID_REDIRECT_URI,
      webhook: process.env.PLAID_TRANSACTIONS_WEBHOOK_URL || undefined,
      transactions: {
        days_requested: 90,
      },
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("create_link_token error:", getPlaidErrorData(err));
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// ---------- 2) Exchange public_token ----------
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { deviceId, public_token } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }

    if (!public_token) {
      return res.status(400).json({ error: "Missing public_token" });
    }

    const exchange = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    let institution_name = "Linked Bank";

    try {
      const itemResp = await plaidClient.itemGet({ access_token });
      const institutionId = itemResp.data.item.institution_id;

      if (institutionId) {
        const instResp = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: ["US"],
        });

        institution_name = instResp.data.institution.name || institution_name;
      }
    } catch (institutionErr) {
      console.warn(
        "Could not resolve institution name:",
        getPlaidErrorData(institutionErr)
      );
    }

    const existingItems = await getLinkedItems(deviceId);
    const normalizedInstitution = normalizeInstitutionName(institution_name);

    const exactItemExists = existingItems.some((item) => item.item_id === item_id);

    let updatedItems = existingItems;

    if (exactItemExists) {
      updatedItems = existingItems.map((item) =>
        item.item_id === item_id
          ? { ...item, access_token, institution_name }
          : item
      );
    } else {
      const duplicateInstitutionItems = existingItems.filter(
        (item) =>
          normalizeInstitutionName(item.institution_name) === normalizedInstitution
      );

      for (const oldItem of duplicateInstitutionItems) {
        try {
          await plaidClient.itemRemove({
            access_token: oldItem.access_token,
          });
        } catch (removeErr) {
          console.warn(
            `Plaid itemRemove failed while replacing duplicate institution ${oldItem.item_id}:`,
            getPlaidErrorData(removeErr)
          );
        }

        try {
          await clearItemState(deviceId, oldItem.item_id);
        } catch (stateErr) {
          console.warn(
            `Failed clearing old item state for ${oldItem.item_id}:`,
            stateErr
          );
        }
      }

      updatedItems = existingItems.filter(
        (item) =>
          normalizeInstitutionName(item.institution_name) !== normalizedInstitution
      );

      updatedItems.push({ access_token, item_id, institution_name });
    }

    await setLinkedItems(deviceId, updatedItems);

    await setItemState(deviceId, item_id, {
      cursor: null,
      transactions: [],
    });

    res.json({
      ok: true,
      item_id,
      institution_name,
      linked_item_count: updatedItems.length,
    });
  } catch (err) {
    console.error("exchange_public_token error:", getPlaidErrorData(err));
    res.status(500).json({ error: "Failed to exchange public token" });
  }
});

// ---------- 3) Fetch Accounts + Transactions from ALL linked banks ----------
app.post("/plaid/get_accounts_and_transactions", async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }

    console.log(`[refresh] start deviceId=${deviceId}`);

    const linkedItems = await getLinkedItems(deviceId);

    if (linkedItems.length === 0) {
      return res.status(400).json({
        error: "No linked banks for this deviceId",
        code: "NO_LINKED_BANKS",
      });
    }

    const allAccounts = [];
    const allTransactions = [];
    const linkedInstitutions = [];
    const itemErrors = [];

    let totalAdded = 0;
    let totalModified = 0;
    let totalRemoved = 0;

    for (const linkedItem of linkedItems) {
      const { access_token, item_id, institution_name } = linkedItem;

      try {
        const savedState = await getItemState(deviceId, item_id);
        const savedCursor = savedState.cursor || null;
        const savedTransactions = savedState.transactions || [];

        const {
          accounts: freshAccounts,
          liveBalanceRefreshSucceeded,
        } = await fetchFreshAccounts(access_token, institution_name, item_id);

        const syncResp = await fetchTransactionsSyncAllWithRetry(access_token, savedCursor);

        const mergedTransactions = mergeTransactions(
          savedTransactions,
          syncResp.added || [],
          syncResp.modified || [],
          syncResp.removed || []
        );

        await setItemState(deviceId, item_id, {
          cursor: syncResp.next_cursor || savedCursor,
          transactions: mergedTransactions,
        });

        totalAdded += (syncResp.added || []).length;
        totalModified += (syncResp.modified || []).length;
        totalRemoved += (syncResp.removed || []).length;

        const accountsWithInstitution = freshAccounts.map((acct) => ({
          ...acct,
          institution_name,
          linked_item_id: item_id,
        }));

        const transactionsWithInstitution = mergedTransactions.map((txn) => ({
          ...txn,
          institution_name,
          linked_item_id: item_id,
        }));

        allAccounts.push(...accountsWithInstitution);
        allTransactions.push(...transactionsWithInstitution);

        linkedInstitutions.push({
          item_id,
          institution_name,
          account_count: freshAccounts.length,
          previous_cursor: savedCursor,
          next_cursor: syncResp.next_cursor || savedCursor,
          added_count: (syncResp.added || []).length,
          modified_count: (syncResp.modified || []).length,
          removed_count: (syncResp.removed || []).length,
          total_cached_transactions: mergedTransactions.length,
          live_balance_refresh_succeeded: liveBalanceRefreshSucceeded,
        });

        console.log(
          `[refresh] item=${institution_name} balancesLive=${liveBalanceRefreshSucceeded} added=${(syncResp.added || []).length} modified=${(syncResp.modified || []).length} removed=${(syncResp.removed || []).length} cached=${mergedTransactions.length}`
        );
      } catch (itemErr) {
        const errData = getPlaidErrorData(itemErr);

        console.error(`Error fetching data for item ${item_id}:`, errData);

        itemErrors.push({
          item_id,
          institution_name,
          error_code: errData?.error_code || "UNKNOWN_ERROR",
          error_message: errData?.error_message || "Unable to fetch item data",
        });
      }
    }

    const uniqueAccounts = dedupeAccounts(allAccounts);
    const uniqueTransactions = sortTransactionsNewestFirst(
      dedupeTransactions(allTransactions)
    );

    if (uniqueAccounts.length === 0 && itemErrors.length > 0) {
      return res.status(500).json({
        error: "Failed to fetch data",
        code: "FETCH_FAILED",
        linkedInstitutions,
        itemErrors,
      });
    }

    console.log(
      `[refresh] done deviceId=${deviceId} accounts=${uniqueAccounts.length} transactions=${uniqueTransactions.length} added=${totalAdded} modified=${totalModified} removed=${totalRemoved}`
    );

    res.json({
      accounts: uniqueAccounts,
      transactions: uniqueTransactions,
      linkedInstitutions,
      itemErrors,
      refreshStatus: {
        requested: true,
        succeeded: itemErrors.length === 0,
        partial: itemErrors.length > 0,
        errorCodes: itemErrors.map((e) => e.error_code),
        messages: itemErrors.map((e) => `${e.institution_name}: ${e.error_message}`),
        stats: {
          added: totalAdded,
          modified: totalModified,
          removed: totalRemoved,
        },
      },
    });
  } catch (err) {
    console.error(
      "get_accounts_and_transactions error:",
      getPlaidErrorData(err)
    );
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// ---------- 4) Debug: list linked banks for device ----------
app.post("/plaid/list_linked_banks", async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }

    const linkedItems = await getLinkedItems(deviceId);

    const enriched = await Promise.all(
      linkedItems.map(async (item) => {
        const state = await getItemState(deviceId, item.item_id);
        return {
          item_id: item.item_id,
          institution_name: item.institution_name,
          has_cursor: !!state.cursor,
          cached_transaction_count: (state.transactions || []).length,
        };
      })
    );

    res.json({
      ok: true,
      linkedBanks: enriched,
      count: linkedItems.length,
    });
  } catch (error) {
    console.error("list_linked_banks error:", error);
    res.status(500).json({ error: "Failed to list linked banks" });
  }
});

// ---------- 5) Unlink ALL banks ----------
app.post("/plaid/unlink", async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }

    const linkedItems = await getLinkedItems(deviceId);
    const removedCount = linkedItems.length;

    for (const item of linkedItems) {
      try {
        await plaidClient.itemRemove({
          access_token: item.access_token,
        });
      } catch (removeErr) {
        console.warn(
          `Plaid itemRemove failed for ${item.item_id}:`,
          getPlaidErrorData(removeErr)
        );
      }

      try {
        await clearItemState(deviceId, item.item_id);
      } catch (stateErr) {
        console.warn(
          `Failed clearing item state for ${item.item_id}:`,
          stateErr
        );
      }
    }

    await clearLinkedItems(deviceId);

    res.json({ ok: true, removedCount });
  } catch (error) {
    console.error("unlink error:", error);
    res.status(500).json({ error: "Failed to unlink banks" });
  }
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`PocketGuard backend running on port ${PORT} env=${PLAID_ENV}`);
});