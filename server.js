import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

// ---------- MVP storage ----------
// deviceId => [ { access_token, item_id, institution_name } ]
const tokenStore = new Map();

// ---------- Helpers ----------
function getLinkedItems(deviceId) {
  const items = tokenStore.get(deviceId);
  return Array.isArray(items) ? items : [];
}

function setLinkedItems(deviceId, items) {
  tokenStore.set(deviceId, items);
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

// ---------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

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
            "/": "/plaid/oauth*"
          }
        ]
      }
    ]
  }
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
    console.error("create_link_token error:", err?.response?.data || err);
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
        institutionErr?.response?.data || institutionErr
      );
    }

    const existingItems = getLinkedItems(deviceId);

    const alreadyLinked = existingItems.some((item) => item.item_id === item_id);

    let updatedItems;
    if (alreadyLinked) {
      updatedItems = existingItems.map((item) =>
        item.item_id === item_id
          ? { ...item, access_token, institution_name }
          : item
      );
    } else {
      updatedItems = [
        ...existingItems,
        { access_token, item_id, institution_name },
      ];
    }

    setLinkedItems(deviceId, updatedItems);

    res.json({
      ok: true,
      item_id,
      institution_name,
      linked_item_count: updatedItems.length,
    });
  } catch (err) {
    console.error("exchange_public_token error:", err?.response?.data || err);
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

    const linkedItems = getLinkedItems(deviceId);

    if (linkedItems.length === 0) {
      return res.status(400).json({ error: "No linked banks for this deviceId" });
    }

    const now = new Date();
    const end = endDate || now.toISOString().slice(0, 10);
    const start =
      startDate ||
      new Date(now.getTime() - 90 * 86400 * 1000).toISOString().slice(0, 10);

    const allAccounts = [];
    const allTransactions = [];
    const linkedInstitutions = [];

    for (const linkedItem of linkedItems) {
      const { access_token, item_id, institution_name } = linkedItem;

      try {
        const accountsResp = await plaidClient.accountsGet({
          access_token,
        });

        const txResp = await plaidClient.transactionsGet({
          access_token,
          start_date: start,
          end_date: end,
          options: {
            count: 500,
            offset: 0,
          },
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
        console.error(
          `Error fetching data for item ${item_id}:`,
          itemErr?.response?.data || itemErr
        );
      }
    }

    const uniqueAccounts = dedupeAccounts(allAccounts);
    const uniqueTransactions = dedupeTransactions(allTransactions).sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });

    res.json({
      accounts: uniqueAccounts,
      transactions: uniqueTransactions,
      linkedInstitutions,
      dateRange: { start, end },
    });
  } catch (err) {
    console.error(
      "get_accounts_and_transactions error:",
      err?.response?.data || err
    );

    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// ---------- 4) Debug: list linked banks for device ----------
app.post("/plaid/list_linked_banks", (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: "Missing deviceId" });
  }

  const linkedItems = getLinkedItems(deviceId);

  res.json({
    ok: true,
    linkedBanks: linkedItems.map((item) => ({
      item_id: item.item_id,
      institution_name: item.institution_name,
    })),
    count: linkedItems.length,
  });
});

// ---------- 5) Unlink ALL banks ----------
app.post("/plaid/unlink", (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: "Missing deviceId" });
  }

  const removedCount = getLinkedItems(deviceId).length;
  tokenStore.delete(deviceId);

  res.json({ ok: true, removedCount });
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`PocketGuard backend running on port ${PORT} env=${PLAID_ENV}`);
});