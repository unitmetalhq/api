import { Elysia } from "elysia";
import { openapi } from "@elysia/openapi";
import { rpc } from "./modules/rpc";
import { prices } from "./modules/prices";
import { swapagg } from "./modules/swapagg";
import { markets } from "./modules/markets";
import { MarketsService } from "./modules/markets/service";

// Warm the markets cache before accepting traffic. The cron job inside
// the markets module only fires every 5 minutes, so without this the
// first responses to `/markets` after a cold boot would be empty.
// A failure here is logged but non-fatal — the next cron tick will retry,
// and we'd rather serve an empty list briefly than refuse to start.
try {
  await MarketsService.refreshMarkets();
} catch (err) {
  console.error("[markets] cold-start refresh failed:", err);
}

const app = new Elysia()
  .use(openapi())
  .get("/", () => "Hello, World!")
  .use(rpc)
  .use(prices)
  .use(swapagg)
  .use(markets)
  .listen(8000);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
