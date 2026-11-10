import { createApp } from "vue";
import App from "./App.vue";
import { STORE } from "./state/inject.ts";
import { createStore } from "./state/store.ts";
import { PlannerClient, type WorkerLike } from "./worker/client.ts";
import "./styles.css";
import "./extra.css";

const worker = new Worker(new URL("./worker/planner.worker.ts", import.meta.url), { type: "module" });
const store = createStore(new PlannerClient(worker as unknown as WorkerLike), import.meta.env.BASE_URL);
createApp(App).provide(STORE, store).mount("#app");
void store.init();
