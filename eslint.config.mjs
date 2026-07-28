import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  { ignores: [".next/**", "node_modules/**", "data/**", "worker/**", "deploy/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // The transparent senders load lazily through createRequire because they
      // drag in utxo-lib and the t2z prover. See src/lib/zcash/send.ts.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Test files spawn helpers and poke at internals; the app rules do not fit.
    files: ["**/*.test.ts", "scripts/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];
