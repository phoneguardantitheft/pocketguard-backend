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
const PLAID_ENV = process.env.PLAID_ENV || "sandbox"; // sandbox | development | production
const PORT = process.env.PORT || 3000;

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error("Missing PLAID_CLIENT_ID or PLAID_SECRET in env.");
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
const tokenStore = new Map(); // deviceId => { access_token, item_id }

app.get("/health", (req, res) => res.json({ ok: true }));

// 1) Create a link_token for Plaid Link
app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: deviceId },
      client_name: "PocketGuard",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// 2) Exchange public_token -> access_token
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { deviceId, public_token } = req.body;
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });
    if (!public_token) return res.status(400).json({ error: "Missing public_token" });

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    tokenStore.set(deviceId, { access_token, item_id });

    res.json({ ok: true, item_id });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: "Failed to exchange public token" });
  }
});

// 3) Fetch accounts + recent transactions
app.post("/plaid/get_accounts_and_transactions", async (req, res) => {
  try {
    const { deviceId, startDate, endDate } = req.body;
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

    const record = tokenStore.get(deviceId);
    if (!record?.access_token) {
      return res.status(400).json({ error: "No linked bank for this deviceId" });
    }

    const access_token = record.access_token;

    const accountsResp = await plaidClient.accountsGet({ access_token });

    const now = new Date();
    const end = endDate || now.toISOString().slice(0, 10);
    const start =
      startDate ||
      new Date(now.getTime() - 90 * 86400 * 1000).toISOString().slice(0, 10);

    const txResp = await plaidClient.transactionsGet({
      access_token,
      start_date: start,
      end_date: end,
      options: { count: 500, offset: 0 },
    });

    res.json({
      accounts: accountsResp.data.accounts,
      transactions: txResp.data.transactions,
      item: txResp.data.item,
      dateRange: { start, end },
    });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// 4) Optional: Unlink
app.post("/plaid/unlink", (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });
  tokenStore.delete(deviceId);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`PocketGuard backend running on port ${PORT} env=${PLAID_ENV}`);
});