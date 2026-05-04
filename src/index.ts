import { Elysia } from "elysia";
import { openapi } from "@elysia/openapi";
import { rpc } from "./modules/rpc";
import { prices } from "./modules/prices";
import { swapagg } from "./modules/swapagg";

const app = new Elysia()
  .use(openapi())
  .get("/", () => "Hello, World!")
  .use(rpc)
  .use(prices)
  .use(swapagg)
  .listen(8000);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
