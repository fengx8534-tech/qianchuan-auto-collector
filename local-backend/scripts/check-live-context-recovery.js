#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { findLiveContextFromState } = require("../lib/qianchuan-url");

const state = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/state.json"), "utf8"));
const context = findLiveContextFromState(state, state.config?.expectedAccountId);

assert(context.liveRoomId, "state must recover a live_room_id");
assert(context.sourceUrl?.includes("/board-next"), "live context must come from a board-next URL");
assert(context.sourceUrl?.includes(`live_room_id=${context.liveRoomId}`), "source URL must match the recovered room");
assert(Number(context.receivedAt) > 0, "live context must retain freshness metadata");

console.log(JSON.stringify({ ok: true, ...context }));
