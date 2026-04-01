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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPlaidErrorData(err) {
  return err?.response?.data || err;
}

function isProductNotReadyError(err) {
  const data = getPlaidErrorData(err);
  return data?.error_code === "PRODUCT_NOT_READY";
}

function normalizeInstitutionName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

async function fetchTransactionsWithRetry({
  access_token,
  start_date,
  end_date,
  maxAttempts = 5,
  delayMs = 2500,
}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await plaidClient.transactionsGet({
        access_token,
        start_date,
        end_date,
        options: {
          count: 500,
          offset: 0,
        },
      });
    } catch (err) {
      lastError = err;

      if (!isProductNotReadyError(err) || attempt === maxAttempts) {
        throw err;
      }

      console.warn(
        `transactionsGet PRODUCT_NOT_READY (attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
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
      }

      updatedItems = existingItems.filter(
        (item) =>
          normalizeInstitutionName(item.institution_name) !== normalizedInstitution
      );

      updatedItems.push({ access_token, item_id, institution_name });
    }

    await setLinkedItems(deviceId, updatedItems);

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
    const { deviceId, startDate, endDate } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }

    const linkedItems = await getLinkedItems(deviceId);

    if (linkedItems.length === 0) {
      return res.status(400).json({
        error: "No linked banks for this deviceId",
        code: "NO_LINKED_BANKS",
      });
    }

    const now = new Date();
    const end = endDate || now.toISOString().slice(0, 10);
    const start =
      startDate ||
      new Date(now.getTime() - 90 * 86400 * 1000).toISOString().slice(0, 10);

    const allAccounts = [];
    const allTransactions = [];
    const linkedInstitutions = [];
    const itemErrors = [];

    for (const linkedItem of linkedItems) {
      const { access_token, item_id, institution_name } = linkedItem;

      try {
        const accountsResp = await plaidClient.accountsGet({
          access_token,
        });

        const txResp = await fetchTransactionsWithRetry({
          access_token,
          start_date: start,
          end_date: end,
          maxAttempts: 5,
          delayMs: 2500,
        });

        const accountsWithInstitution = accountsResp.data.accounts.map((acct) => ({
          ...acct,
          institution_name,
          linked_item_id: item_id,
        }));

        const transactionsWithInstitution = txResp.data.transactions.map((txn) => ({
          ...txn,
          institution_name,
          linked_item_id: item_id,
        }));

        allAccounts.push(...accountsWithInstitution);
        allTransactions.push(...transactionsWithInstitution);

        linkedInstitutions.push({
          item_id,
          institution_name,
          account_count: accountsResp.data.accounts.length,
        });
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
    const uniqueTransactions = dedupeTransactions(allTransactions).sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });

    if (uniqueAccounts.length === 0 && itemErrors.length > 0) {
      const hasProductNotReady = itemErrors.some(
        (e) => e.error_code === "PRODUCT_NOT_READY"
      );

      return res.status(hasProductNotReady ? 202 : 500).json({
        error: hasProductNotReady
          ? "Transactions are still being prepared. Please refresh again shortly."
          : "Failed to fetch data",
        code: hasProductNotReady ? "PRODUCT_NOT_READY" : "FETCH_FAILED",
        linkedInstitutions,
        itemErrors,
        dateRange: { start, end },
      });
    }

    res.json({
      accounts: uniqueAccounts,
      transactions: uniqueTransactions,
      linkedInstitutions,
      itemErrors,
      dateRange: { start, end },
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

    res.json({
      ok: true,
      linkedBanks: linkedItems.map((item) => ({
        item_id: item.item_id,
        institution_name: item.institution_name,
      })),
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