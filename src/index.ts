import { Elysia } from "elysia";
import { rpc } from "./modules/rpc";
import { prices } from "./modules/prices";

const app = new Elysia()
  .get("/", () => "Hello, World!")
  .use(rpc)
  .use(prices)
  .listen(8000);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`
);
