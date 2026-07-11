import { spawn, execFile } from "child_process";
import { readFile, readdir, mkdir, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

/**
 * Volcengine SSO Login via arkcli subprocess
 *
 * Multi-account isolation: each connection gets its own arkcli HOME directory
 * at <DATA_DIR>/arkcli-accounts/<accountId>/. This prevents different accounts
 * from overwriting each other's arkcli identity/profile state.
 *
 * Flow:
 *   Phase 1: `arkcli auth login --no-browser` -> outputs SSO URL (uses global HOME)
 *   Phase 2: `arkcli auth login --no-browser --code <authCode>` -> completes login
 *            (uses a temp HOME dir, then renames to arkcli-accounts/<accountId>/)
 *   Then: Read <arkcliHome>/.arkcli/identities/<account_id>/ for STS credentials
 */

const ARKCLI_ACCOUNTS_DIR = join(process.env.DATA_DIR || join(homedir(), ".9router"), "arkcli-accounts");

/**
 * Build arkcli env for a specific isolated HOME directory
 */
function getIsolatedArkcliEnv(arkcliHome) {
  return {
    ...process.env,
    HOME: arkcliHome,
    ARKCLI_ALLOW_HEADLESS_ACTIVATION: "1",
    VOLC_INIT_REGION: "cn-beijing",
    VOLC_INIT_PROJECT_NAME: "default",
  };
}

/**
 * Find the arkcli binary path
 */
function findArkcli() {
  return new Promise((resolve, reject) => {
    execFile("which", ["arkcli"], (err, stdout) => {
      if (err) {
        reject(new Error("arkcli not found. Install with: npm install -g @volcengine/ark-cli"));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Phase 1: Start arkcli --no-browser and extract the SSO URL
 * Returns the SSO authorization URL that the user should open in a browser
 *
 * Creates an isolated HOME directory so Phase 2 can find the pending SSO session
 * (.sso-pending.json with code_verifier/state) in the same HOME.
 *
 * @returns {Promise<{ ssoUrl: string, arkcliHome: string }>}
 */
export async function startSsoLogin() {
  const arkcliPath = await findArkcli();

  // Create an isolated HOME directory for this login session
  await mkdir(ARKCLI_ACCOUNTS_DIR, { recursive: true });
  const arkcliHome = join(ARKCLI_ACCOUNTS_DIR, `_pending_${Date.now()}`);
  await mkdir(arkcliHome, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(
      arkcliPath,
      ["auth", "login", "--no-browser", "--format", "json", "--region", "cn-beijing", "--project-name", "default"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: getIsolatedArkcliEnv(arkcliHome),
      }
    );

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        rm(arkcliHome, { recursive: true, force: true }).catch(() => {});
        reject(new Error("Timeout waiting for SSO URL from arkcli"));
      }
    }, 15000);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
      const urlMatch = stdout.match(/https:\/\/signin\.volcengine\.com\/[^\s]+/);
      if (urlMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve({ ssoUrl: urlMatch[0], arkcliHome });
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
      const urlMatch = stderr.match(/https:\/\/signin\.volcengine\.com\/[^\s]+/);
      if (urlMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve({ ssoUrl: urlMatch[0], arkcliHome });
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        rm(arkcliHome, { recursive: true, force: true }).catch(() => {});
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        const combined = stdout + stderr;
        const urlMatch = combined.match(/https:\/\/signin\.volcengine\.com\/[^\s]+/);
        if (urlMatch) {
          resolve({ ssoUrl: urlMatch[0], arkcliHome });
        } else {
          rm(arkcliHome, { recursive: true, force: true }).catch(() => {});
          reject(new Error(`arkcli exited with code ${code}. Output: ${combined}`));
        }
      }
    });
  });
}

/**
 * Phase 2: Feed the authorization code to arkcli to complete login
 *
 * Uses the same isolated HOME directory from Phase 1 so arkcli can find
 * the pending SSO session (.sso-pending.json with code_verifier/state).
 *
 * @param {string} authCode - Base64 authorization code from browser
 * @param {string} arkcliHome - The isolated HOME from Phase 1's startSsoLogin
 * @returns {Promise<{ success: boolean, arkcliHome?: string, error?: string }>}
 */
export async function completeSsoLogin(authCode, arkcliHome) {
  if (!authCode || !authCode.trim()) {
    throw new Error("Authorization code is required");
  }
  if (!arkcliHome) {
    throw new Error("arkcliHome is required (must come from Phase 1 startSsoLogin)");
  }

  const arkcliPath = await findArkcli();

  // Use the same HOME from Phase 1 (contains .sso-pending.json)
  const result = await runArkcliLogin(arkcliPath, authCode, arkcliHome);

  if (!result.success) {
    // Clean up temp dir on failure
    await rm(arkcliHome, { recursive: true, force: true }).catch(() => {});
    return result;
  }

  // Read the identity directory to get the accountId for the final path
  const identitiesDir = join(arkcliHome, ".arkcli", "identities");
  const accountId = await readIdentityAccountId(identitiesDir);

  if (!accountId) {
    return {
      success: false,
      error: "SSO login completed but could not determine account ID from arkcli identity",
    };
  }

  // Sync SSO tokens to .env so arkcli can refresh STS after it expires.
  // arkcli reads refresh_token from .env (not from identities/*/token.json),
  // so without this step, accounts that previously had API Key config would
  // have an empty .env and fail with "无 refresh_token 可用" on STS refresh.
  await syncTokensToEnv(arkcliHome, identitiesDir);

  // Rename temp dir to final arkcliHome (by accountId)
  const finalHome = join(ARKCLI_ACCOUNTS_DIR, accountId);
  await rm(finalHome, { recursive: true, force: true }).catch(() => {});
  await rename(arkcliHome, finalHome);

  return { success: true, arkcliHome: finalHome };
}

/**
 * Write SSO tokens from identities/<id>/token.json into .arkcli/.env
 * so arkcli can refresh STS after expiry.
 */
async function syncTokensToEnv(arkcliHome, identitiesDir) {
  let entries;
  try {
    entries = await readdir(identitiesDir, { withFileTypes: true });
  } catch {
    return;
  }

  const identityDirs = entries.filter((e) => e.isDirectory());
  if (identityDirs.length === 0) return;

  const identityPath = join(identitiesDir, identityDirs[0].name);
  let token, sts;
  try {
    token = JSON.parse(await readFile(join(identityPath, "token.json"), "utf8"));
    sts = JSON.parse(await readFile(join(identityPath, "sts.json"), "utf8"));
  } catch {
    return;
  }

  const envLines = [];
  envLines.push("");
  if (token.id_token) envLines.push(`VOLCENGINE_ID_TOKEN="${token.id_token}"`);
  if (token.timestamp_ms) envLines.push(`VOLCENGINE_ID_TOKEN_TIMESTAMP="${token.timestamp_ms}"`);
  if (token.refresh_token) envLines.push(`VOLCENGINE_REFRESH_TOKEN="${token.refresh_token}"`);
  if (token.client_id) envLines.push(`VOLCENGINE_OAUTH_CLIENT_ID="${token.client_id}"`);
  if (sts.ak) envLines.push(`VOLCENGINE_STS_ACCESS_KEY="${sts.ak}"`);
  if (sts.sk) envLines.push(`VOLCENGINE_STS_SECRET_KEY="${sts.sk}"`);
  if (sts.session_token) envLines.push(`VOLCENGINE_STS_SESSION_TOKEN="${sts.session_token}"`);
  if (sts.expires_at) envLines.push(`VOLCENGINE_STS_EXPIRES_AT_MS="${sts.expires_at}"`);

  const envPath = join(arkcliHome, ".arkcli", ".env");
  try {
    // Read existing .env to preserve any API Key lines
    let existing = "";
    try {
      existing = await readFile(envPath, "utf8");
    } catch {}

    // Remove any existing SSO-related lines to avoid duplicates
    const ssoKeys = [
      "VOLCENGINE_ID_TOKEN", "VOLCENGINE_ID_TOKEN_TIMESTAMP",
      "VOLCENGINE_REFRESH_TOKEN", "VOLCENGINE_OAUTH_CLIENT_ID",
      "VOLCENGINE_STS_ACCESS_KEY", "VOLCENGINE_STS_SECRET_KEY",
      "VOLCENGINE_STS_SESSION_TOKEN", "VOLCENGINE_STS_EXPIRES_AT_MS",
    ];
    const keptLines = existing
      .split("\n")
      .filter((line) => !ssoKeys.some((k) => line.startsWith(`${k}=`)));

    const newContent = keptLines.join("\n").replace(/\n+$/, "\n") + envLines.join("\n") + "\n";
    await writeFile(envPath, newContent, { mode: 0o600 });
  } catch {}
}

/**
 * Run arkcli auth login with --code in an isolated HOME
 */
function runArkcliLogin(arkcliPath, authCode, arkcliHome) {
  return new Promise((resolve) => {
    const child = spawn(
      arkcliPath,
      ["auth", "login", "--no-browser", "--code", authCode.trim(), "--format", "json", "--region", "cn-beijing", "--project-name", "default"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: getIsolatedArkcliEnv(arkcliHome),
      }
    );

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        resolve({ success: false, error: "Timeout waiting for arkcli to complete login" });
      }
    }, 30000);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);

        const combined = stdout + stderr;

        // Check for JSON error even on exit code 0
        let jsonError = null;
        try {
          const jsonMatch = combined.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed?.ok === false && parsed?.error?.message) {
              jsonError = parsed.error.message;
            }
          }
        } catch {}

        if (jsonError) {
          // BuildFirstProfileSet failure: SSO tokens saved but profile not created.
          // Try creating profile non-interactively in the same isolated HOME.
          if (/BuildFirstProfileSet|选择项目|Project.*cancelled/i.test(jsonError)) {
            createProfileNonInteractive(arkcliPath, arkcliHome)
              .then((profileResult) => {
                if (profileResult.success) {
                  resolve({ success: true, recovered: true });
                } else {
                  resolve({
                    success: false,
                    error: `SSO 完成但 profile 创建失败: ${profileResult.error}\n原始错误: ${jsonError}`,
                  });
                }
              })
              .catch((err) => {
                resolve({
                  success: false,
                  error: `SSO 完成但 profile 创建失败: ${err.message}\n原始错误: ${jsonError}`,
                });
              });
          } else {
            resolve({ success: false, error: jsonError });
          }
        } else if (code === 0) {
          resolve({ success: true });
        } else {
          let errorMsg = `arkcli exited with code ${code}`;
          try {
            const jsonMatch = combined.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed?.error?.message) errorMsg = parsed.error.message;
            }
          } catch {}
          resolve({ success: false, error: `${errorMsg}\n\nFull output:\n${combined.slice(0, 2000)}` });
        }
      }
    });
  });
}

/**
 * Fallback: create profiles non-interactively after SSO token is saved
 * but before profile initialization can complete (BuildFirstProfileSet failure
 * in --no-browser mode where the user can't interactively pick a plan).
 *
 * Strategy:
 * 1. If arkcli already created profiles, keep them.
 * 2. Try creating an agent-plan profile (auto-binds API Key for Agent Plan users).
 * 3. Also create a platform profile for quota/usage queries.
 */
function createProfileNonInteractive(arkcliPath, arkcliHome) {
  return new Promise((resolve) => {
    const env = getIsolatedArkcliEnv(arkcliHome);

    // Check if arkcli already created profiles
    execFile(
      arkcliPath,
      ["profile", "list", "--format", "json"],
      { timeout: 10000, env, maxBuffer: 1024 * 1024 },
      (listErr, listStdout) => {
        let existingProfiles = [];
        if (!listErr) {
          try {
            const listData = JSON.parse(listStdout);
            existingProfiles = listData?.profiles || [];
          } catch {}
        }

        if (existingProfiles.length > 0) {
          // Already have profiles, don't overwrite
          resolve({ success: true, skipped: true });
          return;
        }

        // No profiles -- try agent-plan first (auto-binds API Key), then platform
        spawnProfileCreate(arkcliPath, arkcliHome, "agent-plan")
          .then((agentResult) => {
            // Also create platform profile for usage queries (don't set as default)
            return spawnProfileCreate(arkcliPath, arkcliHome, "platform", false)
              .catch(() => null)
              .then(() => agentResult);
          })
          .then(resolve)
          .catch(() => {
            // agent-plan failed (e.g. no subscription) -- fall back to platform only
            spawnProfileCreate(arkcliPath, arkcliHome, "platform").then(resolve);
          });
      }
    );
  });
}

function spawnProfileCreate(arkcliPath, arkcliHome, type, setDefault = true) {
  return new Promise((resolve) => {
    const args = [
      "profile", "create",
      "--no-interactive",
      "--type", type,
      "--region", "cn-beijing",
      "--format", "json",
    ];
    if (setDefault) args.push("--set-default");

    const child = spawn(
      arkcliPath,
      args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: getIsolatedArkcliEnv(arkcliHome),
      }
    );

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ success: false, error: "profile create 超时" });
    }, 20000);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const combined = stdout + stderr;

      try {
        const jsonMatch = combined.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed?.ok === false && parsed?.error?.message) {
            resolve({ success: false, error: parsed.error.message });
            return;
          }
        }
      } catch {}

      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: `arkcli profile create exited with code ${code}: ${combined.slice(0, 800)}`,
        });
      }
    });
  });
}

/**
 * Read account ID from the identity directory name (e.g. "volc-2100218428" -> "2100218428")
 */
async function readIdentityAccountId(identitiesDir) {
  let entries;
  try {
    entries = await readdir(identitiesDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const identityDirs = entries.filter((e) => e.isDirectory());
  if (identityDirs.length === 0) return null;

  // Return the account ID from the first identity dir
  return identityDirs[0].name.replace(/^volc-/, "");
}

/**
 * Read identity credentials from a specific arkcli HOME directory
 *
 * @param {string} arkcliHome - The isolated HOME directory for this account
 * @returns {Promise<object|null>} Credentials object or null if not found
 */
export async function readArkcliCredentials(arkcliHome) {
  const arkcliDir = join(arkcliHome, ".arkcli");
  const identitiesDir = join(arkcliDir, "identities");

  let entries;
  try {
    entries = await readdir(identitiesDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const identityDirs = entries.filter((e) => e.isDirectory());
  if (identityDirs.length === 0) return null;

  // Use the first (should be only one per isolated HOME) identity directory
  const identityDir = identityDirs[0];
  const identityPath = join(identitiesDir, identityDir.name);

  try {
    const [stsContent, tokenContent, userIdContent] = await Promise.all([
      readFile(join(identityPath, "sts.json"), "utf8"),
      readFile(join(identityPath, "token.json"), "utf8"),
      readFile(join(identityPath, "user_id.json"), "utf8").catch(() => "{}"),
    ]);

    const sts = JSON.parse(stsContent);
    const token = JSON.parse(tokenContent);
    const userId = JSON.parse(userIdContent);

    // Extract account ID from directory name (e.g. "volc-2100218428" -> "2100218428")
    const accountId = identityDir.name.replace(/^volc-/, "");

    // Decode id_token to get user name
    let userName = "";
    try {
      const idTokenPayload = token.id_token?.split(".")[1];
      if (idTokenPayload) {
        const decoded = JSON.parse(
          Buffer.from(idTokenPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
        );
        userName = decoded.name || decoded.sub || "";
      }
    } catch {}

    return {
      // STS temporary credentials (for V4 signing)
      volcAk: sts.ak,
      volcSk: sts.sk,
      volcSessionToken: sts.session_token,
      volcStsExpiresAt: sts.expires_at,

      // SSO tokens (for refreshing STS)
      volcRefreshToken: token.refresh_token,
      volcIdToken: token.id_token,
      volcClientId: token.client_id,
      volcTokenTimestamp: token.timestamp_ms,
      volcTokenExpiresIn: token.expires_in,

      // Identity info
      volcUserId: userId.user_id || accountId,
      volcAccountId: accountId,
      volcUserName: userName,
      volcIdentityDir: identityDir.name,

      // The isolated arkcli HOME directory for this account
      volcArkcliHome: arkcliHome,
    };
  } catch (e) {
    throw new Error(`Failed to read arkcli credentials: ${e.message}`);
  }
}

/**
 * Check if arkcli is installed
 */
export async function checkArkcliInstalled() {
  try {
    await findArkcli();
    return true;
  } catch {
    return false;
  }
}

/**
 * List API Keys for the account in the given isolated HOME.
 *
 * Two sources:
 * 1. `arkcli api apikey.list` + `apikey.get_raw` -- for platform (控制台按量) keys
 * 2. config.yaml `available_api_keys` -- for agent-plan / coding-plan keys
 *    (these are NOT returned by apikey.list, and the full key is stored in config.yaml)
 *
 * @param {string} arkcliHome - The isolated HOME directory
 * @returns {Promise<{keys: Array<{id: string, name: string, apiKey: string, status: string}>, error: string|null}>}
 */
export async function listArkcliApiKeys(arkcliHome) {
  if (!arkcliHome) return { keys: [], error: "arkcliHome is required" };

  const env = getIsolatedArkcliEnv(arkcliHome);
  const keys = [];
  const seenKeys = new Set();

  // Source 1: config.yaml api_key / available_api_keys (agent-plan / coding-plan)
  try {
    const configPath = join(arkcliHome, ".arkcli", "config.yaml");
    const configContent = await readFile(configPath, "utf8");
    const profiles = parseYamlProfiles(configContent);
    for (const [name, profile] of Object.entries(profiles)) {
      // api_key field contains the full key for plan-type profiles
      if (profile.api_key && profile.api_key.startsWith("ark-") && !seenKeys.has(profile.api_key)) {
        seenKeys.add(profile.api_key);
        keys.push({
          id: `config:${name}`,
          name: `${name} (${profile.type || "plan"})`,
          apiKey: profile.api_key,
          status: "active",
        });
      }
      // available_api_keys may have additional keys
      const available = profile.available_api_keys;
      if (Array.isArray(available)) {
        for (const key of available) {
          if (typeof key === "string" && key.startsWith("ark-") && !seenKeys.has(key)) {
            seenKeys.add(key);
            keys.push({
              id: `config:${name}`,
              name: `${name} (${profile.type || "plan"})`,
              apiKey: key,
              status: "active",
            });
          }
        }
      }
    }
  } catch {}

  // Source 2: apikey.list + get_raw (platform / 控制台按量)
  const listResult = await new Promise((resolve) => {
    execFile(
      "arkcli",
      ["api", "apikey.list", "--params", '{"PageSize":100}', "--format", "json"],
      { timeout: 30000, env, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ error: `${err.message}${stderr ? ` (${stderr.slice(0, 200)})` : ""}` });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          if (data?.ok === false) {
            resolve({ error: data?.error?.message || "apikey.list failed" });
            return;
          }
          resolve({ items: data?.Result?.Items || [] });
        } catch {
          resolve({ error: `apikey.list returned non-JSON: ${stdout.slice(0, 200)}` });
        }
      }
    );
  });

  if (listResult.error && keys.length === 0) {
    return { keys: [], error: listResult.error };
  }

  if (listResult.items) {
    for (const item of listResult.items) {
      const id = item.Id || item.id;
      const name = item.Name || item.name || "API Key";
      const status = item.Status || item.status || "active";

      const rawKey = await new Promise((resolve) => {
        execFile(
          "arkcli",
          ["api", "apikey.get_raw", "--params", JSON.stringify({ Id: id }), "--format", "json"],
          { timeout: 15000, env, maxBuffer: 1024 * 1024 },
          (err, stdout) => {
            if (err) { resolve(""); return; }
            try {
              const data = JSON.parse(stdout);
              if (data?.ok === false) { resolve(""); return; }
              resolve(data?.Result?.ApiKey || data?.Result?.Key || "");
            } catch { resolve(""); }
          }
        );
      });

      if (rawKey && !seenKeys.has(rawKey)) {
        seenKeys.add(rawKey);
        keys.push({ id: String(id), name, apiKey: rawKey, status });
      }
    }
  }

  return { keys, error: null };
}

/**
 * Minimal YAML parser for config.yaml profiles section.
 * Only handles the flat key-value structure arkcli uses.
 */
function parseYamlProfiles(content) {
  const profiles = {};
  let currentProfile = null;
  let inAvailableKeys = false;

  for (const line of content.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level profile entry under "profiles:"
    const profileMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (profileMatch) {
      currentProfile = profileMatch[1];
      profiles[currentProfile] = {};
      inAvailableKeys = false;
      continue;
    }

    if (!currentProfile) continue;

    // Key under profile (4 spaces indent)
    const kvMatch = line.match(/^    ([a-zA-Z_]+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      inAvailableKeys = false;
      if (key === "available_api_keys") {
        profiles[currentProfile][key] = [];
        inAvailableKeys = true;
      } else {
        const v = value.trim().replace(/^["']|["']$/g, "");
        profiles[currentProfile][key] = v;
      }
      continue;
    }

    // List item under available_api_keys (4+ spaces "- value")
    const listItemMatch = line.match(/^    +- (.+)$/);
    if (listItemMatch && inAvailableKeys) {
      const v = listItemMatch[1].trim().replace(/^["']|["']$/g, "");
      profiles[currentProfile].available_api_keys.push(v);
    }
  }

  return profiles;
}

/**
 * Get arkcli version
 */
export async function getArkcliVersion() {
  const arkcliPath = await findArkcli();
  return new Promise((resolve) => {
    execFile(arkcliPath, ["--version"], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}
