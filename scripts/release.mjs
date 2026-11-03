// pnpm release <patch|minor|major|X.Y.Z>: bump every version file, commit, push develop.
// Then open the develop → main PR; merging it makes the Release workflow tag and build.
import { execSync } from "node:child_process";
import { setVersion, versions } from "./version.mjs";

const sh = (c) => execSync(c, { stdio: "inherit" });
const out = (c) => execSync(c, { encoding: "utf8" }).trim();
const arg = process.argv[2];
const fail = (m) => { console.error(m); process.exit(1); };

if (!arg) fail("usage: pnpm release <patch|minor|major|X.Y.Z>");
if (out("git branch --show-current") !== "develop") fail("run on develop");
if (out("git status --porcelain")) fail("working tree not clean");

const current = versions()[0][1];
const [maj, min, pat] = current.split(".").map(Number);
const next = { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` }[arg] ?? arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`bad version: ${next}`);
if (out(`git tag -l v${next}`)) fail(`tag v${next} already exists`);

setVersion(next);
sh("cargo update --workspace --offline");
sh(`git commit -am "chore: release ${next}"`);
sh("git push origin develop");
console.log(`\n${current} → ${next}. Open the PR develop → main; merging it tags v${next} and builds the release.`);
