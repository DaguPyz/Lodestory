import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

const form = document.querySelector<HTMLFormElement>("#greet-form");
const input = document.querySelector<HTMLInputElement>("#greet-input");
const message = document.querySelector<HTMLElement>("#greet-msg");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!input || !message) return;
  try {
    message.textContent = await invoke<string>("greet", { name: input.value });
  } catch (error) {
    message.textContent = String(error);
  }
});
