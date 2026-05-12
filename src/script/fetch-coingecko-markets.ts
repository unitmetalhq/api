import Coingecko from "@coingecko/coingecko-typescript";

const apiKey = process.env.COINGECKO_API_KEY;
if (!apiKey) throw new Error("COINGECKO_API_KEY is not set");

const client = new Coingecko({
  demoAPIKey: apiKey,
  environment: "demo",
});

const perPage = 250;
const all: Coingecko.Coins.MarketGetResponse = [];

for (let page = 1; ; page++) {
  const batch = await client.coins.markets.get({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: perPage,
    page,
  });

  if (batch.length === 0) break;
  all.push(...batch);
  console.log(`page ${page}: +${batch.length} (total ${all.length})`);

  if (batch.length < perPage) break;
}

const ids = all.map((c) => c.id).filter((id): id is string => !!id);
console.log(`count: ${all.length}`);
console.log(ids.join(","));
