import { useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function App() {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  async function greet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setMessage(await invoke<string>("greet", { name }));
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <main>
      <h1>Welcome to Lodestory</h1>
      <p>Tauri 2 + React + TypeScript</p>
      <form onSubmit={greet}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="Enter a name"
          aria-label="Name"
        />
        <button type="submit">Greet</button>
      </form>
      <p aria-live="polite">{message}</p>
    </main>
  );
}
