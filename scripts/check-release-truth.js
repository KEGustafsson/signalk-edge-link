#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const failures = [];

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fail(message) {
  failures.push(message);
}

function requireIncludes(content, needle, relativePath) {
  if (!content.includes(needle)) {
    fail(`${relativePath} must contain "${needle}".`);
  }
}

function requireExcludes(content, needle, relativePath) {
  if (content.includes(needle)) {
    fail(`${relativePath} must not contain stale reference "${needle}".`);
  }
}

const packageJson = JSON.parse(readText("package.json"));
const apiReference = readText("docs/api-reference.md");
const docsReadme = readText("docs/README.md");
const architectureOverview = readText("docs/architecture-overview.md");
const publishWorkflow = readText(".github/workflows/publish-packages.yml");
const currentMarker = `current: ${packageJson.version}`;

requireIncludes(apiReference, currentMarker, "docs/api-reference.md");
requireIncludes(docsReadme, currentMarker, "docs/README.md");

function requireNoStaleVersionMarker(content, relativePath) {
  const stalePattern = /current:\s*(\d+\.\d+\.\d+)/g;
  let match;
  while ((match = stalePattern.exec(content)) !== null) {
    if (match[1] !== packageJson.version) {
      fail(
        `${relativePath} must not contain stale version marker "current: ${match[1]}" (expected "current: ${packageJson.version}").`
      );
    }
  }
}

requireNoStaleVersionMarker(apiReference, "docs/api-reference.md");
requireNoStaleVersionMarker(docsReadme, "docs/README.md");

for (const staleName of [
  "bonding-manager.ts",
  "congestion-control.ts",
  "alert-manager.ts",
  "sequence-tracker.ts"
]) {
  if (architectureOverview.includes(staleName)) {
    fail(`docs/architecture-overview.md must not reference ${staleName}.`);
  }
}

for (const currentName of ["bonding.ts", "congestion.ts", "monitoring.ts", "sequence.ts"]) {
  requireIncludes(architectureOverview, currentName, "docs/architecture-overview.md");
}

const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
for (const requiredFile of ["lib/", "public/"]) {
  if (!packageFiles.includes(requiredFile)) {
    fail(`package.json files must include "${requiredFile}".`);
  }
}

const buildIndex = publishWorkflow.indexOf("npm run build");
const packIndex = publishWorkflow.indexOf("npm pack");
const releaseCheckIndex = publishWorkflow.indexOf("npm run check:release-docs");

if (buildIndex === -1) {
  fail(".github/workflows/publish-packages.yml must run npm run build.");
}

if (packIndex === -1) {
  fail(".github/workflows/publish-packages.yml must run npm pack.");
}

if (buildIndex !== -1 && packIndex !== -1 && buildIndex > packIndex) {
  fail(".github/workflows/publish-packages.yml must build before packing.");
}

if (releaseCheckIndex === -1) {
  fail(".github/workflows/publish-packages.yml must run npm run check:release-docs.");
}

if (releaseCheckIndex !== -1 && packIndex !== -1 && releaseCheckIndex > packIndex) {
  fail(".github/workflows/publish-packages.yml must check release docs before packing.");
}

if (failures.length > 0) {
  process.stderr.write("Release truth check failed:\n");
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write("check-release-truth: release docs and package truth look consistent\n");
