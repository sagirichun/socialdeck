#!/usr/bin/env tsx
import { migrate } from "../src/lib/db";

const applied = migrate();
console.log(applied.length ? `applied: ${applied.join(", ")}` : "database already up to date");
