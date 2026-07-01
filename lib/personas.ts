import { promises as fs } from "fs";
import path from "path";
import type { PersonaEntry } from "./types";

const REGISTRY_PATH = path.join(process.cwd(), ".claude", "skills", "personas.json");

// Always-available fallback so the app never has zero personas to offer,
// even if personas.json is missing or fails to parse.
export const DEFAULT_PERSONA: PersonaEntry = {
  id: "explore-repo",
  skillFolder: "explore-repo",
  label: "Architectural Review",
  description:
    "Learning-oriented architectural review — patterns, structure, what's worth stealing or porting.",
};

export async function readPersonas(): Promise<PersonaEntry[]> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? (parsed as PersonaEntry[]) : [];
    return list.length > 0 ? list : [DEFAULT_PERSONA];
  } catch {
    return [DEFAULT_PERSONA];
  }
}
