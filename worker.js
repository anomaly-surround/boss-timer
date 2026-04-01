/**
 * Boss Timer - Cloudflare Worker
 *
 * Handles boss timer state, cron-based Discord notifications,
 * and REST API for the frontend.
 *
 * KV keys: "bosses" (array), "config" (discord settings), "alerts" (sent notifications)
 * Env vars: AUTH_TOKEN (shared secret), BOSS_TIMER (KV namespace binding)
 */

// --- Helpers ---

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function cors() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function auth(request, env) {
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  return token === env.AUTH_TOKEN;
}

// --- Next spawn calculators ---

function getNextFixedSpawn(timeStr, tz) {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  const spawn = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  spawn.setHours(h, m, 0, 0);
  if (spawn <= new Date(now.toLocaleString("en-US", { timeZone: tz }))) {
    spawn.setDate(spawn.getDate() + 1);
  }
  // Convert back to UTC epoch
  const offset = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: tz })).getTime();
  return spawn.getTime() + offset;
}

function getNextWeeklySpawn(targetDay, timeStr, tz) {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const spawn = new Date(local);
  spawn.setHours(h, m, 0, 0);

  const currentDay = local.getDay();
  let daysUntil = targetDay - currentDay;
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0 && spawn <= local) daysUntil = 7;

  spawn.setDate(spawn.getDate() + daysUntil);
  const offset = now.getTime() - local.getTime();
  return spawn.getTime() + offset;
}

function getNextBiweeklySpawn(days, tz) {
  const spawns = days.map((d) => getNextWeeklySpawn(d.day, d.time, tz));
  return Math.min(...spawns);
}

function recalcNextSpawn(boss, fromTime, tz) {
  if (boss.type === "interval") {
    boss.nextSpawn = fromTime + boss.intervalMs;
  } else if (boss.type === "fixed") {
    boss.nextSpawn = getNextFixedSpawn(boss.fixedTime, tz);
  } else if (boss.type === "weekly") {
    boss.nextSpawn = getNextWeeklySpawn(boss.weeklyDay, boss.weeklyTime, tz);
  } else if (boss.type === "biweekly") {
    boss.nextSpawn = getNextBiweeklySpawn(boss.biweeklyDays, tz);
  }
}

// --- Discord ---

async function sendDiscord(webhookUrl, title, description, color) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title,
          description,
          color,
          footer: { text: "Anomaly Timer" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) {
    console.error("Discord webhook error:", e);
  }
}

// --- Cron handler (runs every minute) ---

async function handleScheduled(env) {
  const bosses = JSON.parse(await env.BOSS_TIMER.get("bosses") || "[]");
  const config = JSON.parse(await env.BOSS_TIMER.get("config") || "{}");
  const alerts = JSON.parse(await env.BOSS_TIMER.get("alerts") || "{}");

  if (bosses.length === 0) return;

  const now = Date.now();
  const tz = config.timezone || "America/New_York";
  let changed = false;

  for (const boss of bosses) {
    const remaining = boss.nextSpawn - now;
    const alertMs = (boss.alertMinutes || 5) * 60000;

    // Warning — send when entering alert window
    if (remaining > 0 && remaining <= alertMs && !alerts[boss.id]?.warned && boss.status === "waiting") {
      if (config.onWarning !== false && config.webhookUrl) {
        const minLeft = Math.max(1, Math.round(remaining / 60000));
        await sendDiscord(config.webhookUrl,
          `${boss.name} - Spawning Soon!`,
          `**${boss.name}** spawns in **${minLeft} minute${minLeft !== 1 ? 's' : ''}**!`,
          16760576
        );
      }
      alerts[boss.id] = { ...(alerts[boss.id] || {}), warned: true };
      changed = true;
      // Don't check spawn in the same run — wait for next cron
      continue;
    }

    // Spawned
    if (remaining <= 0 && boss.status === "waiting") {
      // Send warning first if it was never sent
      if (!alerts[boss.id]?.warned && config.onWarning !== false && config.webhookUrl) {
        await sendDiscord(config.webhookUrl,
          `${boss.name} - Spawning Soon!`,
          `**${boss.name}** is about to spawn!`,
          16760576
        );
        alerts[boss.id] = { ...(alerts[boss.id] || {}), warned: true };
        changed = true;
        // Let spawn notification come on next cron run
        continue;
      }

      boss.status = "spawned";
      boss.spawnedAt = now;
      boss.autoResetAt = now + 5 * 60000;
      if (config.onSpawn !== false && config.webhookUrl && !alerts[boss.id]?.spawned) {
        await sendDiscord(config.webhookUrl,
          `${boss.name} has SPAWNED!`,
          `**${boss.name}** is now available!\nAuto-reset in 5 minutes if not killed.`,
          15548997
        );
      }
      alerts[boss.id] = { ...(alerts[boss.id] || {}), spawned: true };
      changed = true;
    }

    // Auto-reset
    if (boss.status === "spawned" && boss.autoResetAt && now >= boss.autoResetAt) {
      boss.status = "waiting";
      boss.spawnedAt = null;
      boss.autoResetAt = null;
      delete alerts[boss.id];
      recalcNextSpawn(boss, now, tz);
      changed = true;
    }
  }

  if (changed) {
    await env.BOSS_TIMER.put("bosses", JSON.stringify(bosses));
    await env.BOSS_TIMER.put("alerts", JSON.stringify(alerts));
  }
}

// --- API handler ---

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return cors();

  const url = new URL(request.url);
  const path = url.pathname;

  // Auth check (except OPTIONS)
  if (!auth(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  // GET /api/bosses
  if (path === "/api/bosses" && request.method === "GET") {
    const bosses = JSON.parse(await env.BOSS_TIMER.get("bosses") || "[]");
    return json({ bosses });
  }

  // POST /api/bosses
  if (path === "/api/bosses" && request.method === "POST") {
    const body = await request.json();
    const bosses = JSON.parse(await env.BOSS_TIMER.get("bosses") || "[]");
    const config = JSON.parse(await env.BOSS_TIMER.get("config") || "{}");
    const tz = config.timezone || "America/New_York";

    const boss = {
      id: Date.now().toString(),
      name: body.name,
      type: body.type,
      alertMinutes: body.alertMinutes || 5,
      status: "waiting",
      spawnedAt: null,
      autoResetAt: null,
      lastDeath: null,
    };

    if (body.type === "interval") {
      boss.intervalMs = body.intervalMs;
      boss.nextSpawn = Date.now() + boss.intervalMs;
    } else if (body.type === "fixed") {
      boss.fixedTime = body.fixedTime;
      boss.nextSpawn = getNextFixedSpawn(body.fixedTime, tz);
    } else if (body.type === "weekly") {
      boss.weeklyDay = body.weeklyDay;
      boss.weeklyTime = body.weeklyTime;
      boss.nextSpawn = getNextWeeklySpawn(body.weeklyDay, body.weeklyTime, tz);
    } else if (body.type === "biweekly") {
      boss.biweeklyDays = body.biweeklyDays;
      boss.nextSpawn = getNextBiweeklySpawn(body.biweeklyDays, tz);
    }

    bosses.push(boss);
    await env.BOSS_TIMER.put("bosses", JSON.stringify(bosses));

    // If boss starts inside the alert window, mark as already warned
    // so the cron doesn't immediately fire a warning
    const remaining = boss.nextSpawn - Date.now();
    const alertMs = boss.alertMinutes * 60000;
    if (remaining <= alertMs) {
      const alerts = JSON.parse(await env.BOSS_TIMER.get("alerts") || "{}");
      alerts[boss.id] = { warned: true };
      await env.BOSS_TIMER.put("alerts", JSON.stringify(alerts));
    }

    return json({ boss });
  }

  // DELETE /api/bosses/:id
  const deleteMatch = path.match(/^\/api\/bosses\/(.+)$/);
  if (deleteMatch && request.method === "DELETE") {
    const id = deleteMatch[1];
    let bosses = JSON.parse(await env.BOSS_TIMER.get("bosses") || "[]");
    bosses = bosses.filter((b) => b.id !== id);
    await env.BOSS_TIMER.put("bosses", JSON.stringify(bosses));

    const alerts = JSON.parse(await env.BOSS_TIMER.get("alerts") || "{}");
    delete alerts[id];
    await env.BOSS_TIMER.put("alerts", JSON.stringify(alerts));
    return json({ ok: true });
  }

  // POST /api/bosses/:id/kill
  const killMatch = path.match(/^\/api\/bosses\/(.+)\/kill$/);
  if (killMatch && request.method === "POST") {
    const id = killMatch[1];
    const body = await request.json().catch(() => ({}));
    const deathTime = body.deathTime || Date.now();

    const bosses = JSON.parse(await env.BOSS_TIMER.get("bosses") || "[]");
    const config = JSON.parse(await env.BOSS_TIMER.get("config") || "{}");
    const tz = config.timezone || "America/New_York";
    const boss = bosses.find((b) => b.id === id);
    if (!boss) return json({ error: "Not found" }, 404);

    boss.status = "waiting";
    boss.spawnedAt = null;
    boss.autoResetAt = null;
    boss.lastDeath = deathTime;
    recalcNextSpawn(boss, deathTime, tz);

    await env.BOSS_TIMER.put("bosses", JSON.stringify(bosses));

    const alerts = JSON.parse(await env.BOSS_TIMER.get("alerts") || "{}");
    delete alerts[id];
    await env.BOSS_TIMER.put("alerts", JSON.stringify(alerts));

    return json({ boss });
  }

  // GET /api/config
  if (path === "/api/config" && request.method === "GET") {
    const config = JSON.parse(await env.BOSS_TIMER.get("config") || "{}");
    return json({
      webhookUrl: config.webhookUrl ? "..." + config.webhookUrl.slice(-8) : "",
      onWarning: config.onWarning !== false,
      onSpawn: config.onSpawn !== false,
      timezone: config.timezone || "America/New_York",
    });
  }

  // PUT /api/config
  if (path === "/api/config" && request.method === "PUT") {
    const body = await request.json();
    const config = JSON.parse(await env.BOSS_TIMER.get("config") || "{}");
    if (body.webhookUrl !== undefined) config.webhookUrl = body.webhookUrl;
    if (body.onWarning !== undefined) config.onWarning = body.onWarning;
    if (body.onSpawn !== undefined) config.onSpawn = body.onSpawn;
    if (body.timezone !== undefined) config.timezone = body.timezone;
    await env.BOSS_TIMER.put("config", JSON.stringify(config));
    return json({ ok: true });
  }

  // POST /api/config/test
  if (path === "/api/config/test" && request.method === "POST") {
    const config = JSON.parse(await env.BOSS_TIMER.get("config") || "{}");
    if (!config.webhookUrl) return json({ error: "No webhook URL" }, 400);
    await sendDiscord(config.webhookUrl, "Test Notification", "Boss timer webhook is working!", 5793266);
    return json({ ok: true });
  }

  // GET /api/debug — check alerts and timing
  if (path === "/api/debug" && request.method === "GET") {
    const bosses = JSON.parse(await env.BOSS_TIMER.get("bosses") || "[]");
    const alerts = JSON.parse(await env.BOSS_TIMER.get("alerts") || "{}");
    const config = JSON.parse(await env.BOSS_TIMER.get("config") || "{}");
    const now = Date.now();
    const debug = bosses.map(b => ({
      name: b.name,
      status: b.status,
      remaining_min: Math.round((b.nextSpawn - now) / 60000 * 10) / 10,
      alertMinutes: b.alertMinutes,
      alerts: alerts[b.id] || {},
      webhookSet: !!config.webhookUrl,
      onWarning: config.onWarning,
    }));
    return json({ now, alerts, debug });
  }

  return json({ error: "Not found" }, 404);
}

// --- Entry points ---

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
