// Local integration only: upstream CodeGraph remains unchanged.
const fs = require('node:fs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const base = '/Users/gouki-youdoo/.codegraph/versions/v0.9.3/lib/dist';
const {ToolHandler} = require(base + '/mcp/tools.js');
const original = ToolHandler.prototype.execute;
const identities = new WeakMap();
ToolHandler.prototype.execute = async function (toolName, args = {}) {
  const requested = args.projectPath || this.cg?.getProjectRoot() || this.defaultProjectHint;
  let proof;
  const started = Date.now();
  if (requested) {
    try {
      const {stdout} = await exec('python3', ['/Users/Shared/codegraph-projects/prepare-sd2-worktree.py', requested],
        {timeout: 280000, maxBuffer: 1024 * 1024});
      proof = JSON.parse(stdout.trim());
      let seen = identities.get(this);
      if (!seen) { seen = new Map(); identities.set(this, seen); }
      if (seen.get(proof.projectPath) !== proof.indexIdentity+':'+proof.sourceFingerprint) {
        const closed = new Set();
        for (const [key,cg] of this.projectCache) {
          if (cg.getProjectRoot() === proof.projectPath) {
            if (!closed.has(cg)) { cg.close(); closed.add(cg); }
            this.projectCache.delete(key);
          }
        }
        if (this.cg?.getProjectRoot() === proof.projectPath) {
          if (!closed.has(this.cg)) this.cg.close();
          this.cg = null;
        }
        seen.set(proof.projectPath, proof.indexIdentity+':'+proof.sourceFingerprint);
      }
      args = {...args, projectPath: proof.projectPath};
    } catch (error) {
      if (error.code !== 42) {
        const detail = error.stderr || error.message;
        return {isError:true, content:[{type:'text',text:'CodeGraph freshness check failed; stale results were not returned. '+detail}]};
      }
    }
  }
  const result = await original.call(this, toolName, args);
  if (proof) {
    try {
      fs.appendFileSync('/Users/Shared/codegraph-projects/query-usage.jsonl', JSON.stringify({
        timestamp:new Date().toISOString(),tool:toolName,projectPath:proof.projectPath,head:proof.head,
        sourceFingerprint:proof.sourceFingerprint,files:proof.files,success:!result.isError,durationMs:Date.now()-started})+'\n');
    } catch {} // Telemetry must never block a successful query.
  }
  return result;
};
require(base + '/bin/codegraph.js');
