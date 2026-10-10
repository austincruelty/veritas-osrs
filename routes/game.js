const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../database');

const client = new Anthropic();

const DATA_DIR = (() => {
  const preferred = process.env.DATA_DIR;
  if (preferred) {
    try { fs.mkdirSync(path.join(preferred, 'uploads'), { recursive: true }); return preferred; } catch {}
  }
  return path.join(__dirname, '..');
})();
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

function checkBingo(tiles, teamNum) {
  const grid = {};
  let maxRow = 0, maxCol = 0;
  for (const t of tiles) {
    grid[`${t.row},${t.col}`] = t.complete ? !!t.complete[teamNum] : false;
    if (t.row > maxRow) maxRow = t.row;
    if (t.col > maxCol) maxCol = t.col;
  }
  for (let r = 0; r <= maxRow; r++) {
    if (Array.from({ length: maxCol + 1 }, (_, c) => grid[`${r},${c}`]).every(Boolean)) return true;
  }
  for (let c = 0; c <= maxCol; c++) {
    if (Array.from({ length: maxRow + 1 }, (_, r) => grid[`${r},${c}`]).every(Boolean)) return true;
  }
  if (maxRow === maxCol) {
    const n = maxRow;
    if (Array.from({ length: n + 1 }, (_, i) => grid[`${i},${i}`]).every(Boolean)) return true;
    if (Array.from({ length: n + 1 }, (_, i) => grid[`${i},${n - i}`]).every(Boolean)) return true;
  }
  return false;
}

function buildBoard(eventId) {
  const event = db.get('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!event) return null;

  const teams = db.all('SELECT * FROM event_teams WHERE event_id = ? ORDER BY team_number', [eventId]);
  const tiles = db.all('SELECT * FROM tiles WHERE event_id = ? ORDER BY row, col', [eventId]);

  const boardTiles = tiles.map(tile => {
    // Individual items (not in a pool)
    const items = db.all('SELECT * FROM tile_items WHERE tile_id = ? AND group_id IS NULL', [tile.id]);
    const itemsWithProgress = items.map((item, idx) => {
      const points = Math.min(idx + 1, 3);
      const qty = item.quantity || 1;
      const counts = {}, done = {};
      for (const team of teams) {
        const row = db.get(
          "SELECT COUNT(*) as c FROM submissions WHERE tile_item_id = ? AND team = ? AND status = 'approved'",
          [item.id, team.team_number]
        );
        const c = row ? row.c : 0;
        counts[team.team_number] = c;
        done[team.team_number] = c >= qty;
      }
      return { ...item, points, quantity: qty, counts, done };
    });

    // Item pools
    const groupRows = db.all('SELECT * FROM tile_item_groups WHERE tile_id = ? ORDER BY display_order', [tile.id]);
    const groups = groupRows.map((g, gIdx) => {
      const gItems = db.all('SELECT * FROM tile_items WHERE group_id = ?', [g.id]);
      const itemsWithCounts = gItems.map(gi => {
        const counts = {};
        for (const team of teams) {
          const row = db.get(
            "SELECT COUNT(*) as c FROM submissions WHERE tile_item_id = ? AND team = ? AND status = 'approved'",
            [gi.id, team.team_number]
          );
          counts[team.team_number] = row ? row.c : 0;
        }
        return { ...gi, counts };
      });
      const totalCounts = {}, done = {};
      for (const team of teams) {
        const total = itemsWithCounts.reduce((sum, gi) => sum + (gi.counts[team.team_number] || 0), 0);
        totalCounts[team.team_number] = total;
        done[team.team_number] = total >= g.target_count;
      }
      return { ...g, items: itemsWithCounts, totalCounts, done, points: Math.min(itemsWithProgress.length + gIdx + 1, 3) };
    });

    const complete = {};
    for (const team of teams) {
      const itemsDone = itemsWithProgress.length === 0 || itemsWithProgress.every(i => i.done[team.team_number]);
      const groupsDone = groups.length === 0 || groups.every(g => g.done[team.team_number]);
      complete[team.team_number] = itemsDone && groupsDone;
    }

    return { ...tile, items: itemsWithProgress, groups, complete };
  });

  const members = db.all('SELECT * FROM team_members WHERE event_id = ? ORDER BY team, player_name', [eventId]);

  const teamResults = teams.map(team => {
    let points = 0;
    boardTiles.forEach(tile => {
      tile.items.forEach(item => { if (item.done[team.team_number]) points += item.points; });
      tile.groups.forEach(g => { points += Math.min(g.totalCounts[team.team_number] || 0, g.target_count); });
    });
    const tilesComplete = boardTiles.filter(t => t.complete[team.team_number]).length;
    return {
      team_number: team.team_number,
      team_name: team.team_name,
      points,
      tiles_complete: tilesComplete,
      bingo: checkBingo(boardTiles, team.team_number)
    };
  });

  return { event, tiles: boardTiles, teams: teamResults, members };
}

module.exports = function makeGameRouter(broadcast) {
  const router = express.Router();

  router.get('/events', (req, res, next) => {
    try {
      const events = db.all('SELECT id, name, status, game_type FROM events ORDER BY created_at DESC');
      res.json(events.map(ev => ({
        ...ev,
        teams: db.all('SELECT team_number, team_name FROM event_teams WHERE event_id = ? ORDER BY team_number', [ev.id])
      })));
    } catch (err) { next(err); }
  });

  router.get('/events/:id/board', (req, res, next) => {
    try {
      const board = buildBoard(req.params.id);
      if (!board) return res.status(404).json({ error: 'Event not found' });
      res.json(board);
    } catch (err) { next(err); }
  });

  router.get('/events/:id/tiles', (req, res, next) => {
    try {
      const tiles = db.all('SELECT * FROM tiles WHERE event_id = ? ORDER BY row, col', [req.params.id]);
      res.json(tiles.map(tile => ({
        ...tile,
        items: db.all('SELECT * FROM tile_items WHERE tile_id = ? AND group_id IS NULL', [tile.id]),
        groups: db.all('SELECT * FROM tile_item_groups WHERE tile_id = ? ORDER BY display_order', [tile.id]).map(g => ({
          ...g,
          items: db.all('SELECT * FROM tile_items WHERE group_id = ?', [g.id])
        }))
      })));
    } catch (err) { next(err); }
  });

  router.get('/events/:id/feed', (req, res, next) => {
    try {
      const entries = db.all(`
        SELECT s.player_name, s.team, s.created_at, ti.item_name, ti.wiki_image
        FROM submissions s
        JOIN tile_items ti ON ti.id = s.tile_item_id
        WHERE s.event_id = ? AND s.status = 'approved'
        ORDER BY s.created_at DESC
        LIMIT 40
      `, [req.params.id]);
      res.json(entries);
    } catch (err) { next(err); }
  });

  router.post('/events/:id/submit', upload.single('screenshot'), async (req, res) => {
    const { player_name, team, tile_item_id } = req.body;
    const cleanup = () => { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} };

    if (!player_name || !team || !tile_item_id || !req.file) {
      cleanup();
      return res.status(400).json({ error: 'player_name, team, tile_item_id, and screenshot are required' });
    }

    const teamNum = parseInt(team);

    const event = db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!event || event.status !== 'active') {
      cleanup();
      return res.status(400).json({ error: 'Event not found or not active' });
    }

    const validTeam = db.get('SELECT * FROM event_teams WHERE event_id = ? AND team_number = ?', [req.params.id, teamNum]);
    if (!validTeam) {
      cleanup();
      return res.status(400).json({ error: 'Invalid team' });
    }

    const member = db.get(
      'SELECT id FROM team_members WHERE event_id = ? AND LOWER(player_name) = LOWER(?) AND team = ?',
      [req.params.id, player_name.trim(), teamNum]
    );
    if (!member) {
      cleanup();
      return res.status(400).json({
        error: `"${player_name}" is not on the roster for ${validTeam.team_name}. Contact an admin to be added before submitting.`
      });
    }

    const tileItem = db.get(`
      SELECT ti.*, t.event_id, t.id as tile_id
      FROM tile_items ti
      JOIN tiles t ON t.id = ti.tile_id
      WHERE ti.id = ? AND t.event_id = ?
    `, [tile_item_id, req.params.id]);

    if (!tileItem) {
      cleanup();
      return res.status(400).json({ error: 'Invalid tile item for this event' });
    }

    const approvedRow = db.get(
      "SELECT COUNT(*) as c FROM submissions WHERE tile_item_id = ? AND team = ? AND status = 'approved'",
      [tile_item_id, teamNum]
    );
    const approvedCount = approvedRow ? approvedRow.c : 0;
    const requiredQty = tileItem.quantity || 1;
    if (approvedCount >= requiredQty) {
      cleanup();
      const plural = requiredQty > 1 ? `all ${requiredQty} drops` : 'this item';
      return res.status(400).json({ error: `Your team has already submitted ${plural} for this item` });
    }

    // If the item belongs to a pool, check whether that pool is already complete
    if (tileItem.group_id) {
      const grp = db.get('SELECT * FROM tile_item_groups WHERE id = ?', [tileItem.group_id]);
      if (grp) {
        const poolCount = db.get(
          "SELECT COUNT(*) as c FROM submissions s JOIN tile_items ti ON ti.id = s.tile_item_id WHERE ti.group_id = ? AND s.team = ? AND s.status = 'approved'",
          [tileItem.group_id, teamNum]
        );
        if ((poolCount?.c || 0) >= grp.target_count) {
          cleanup();
          return res.status(400).json({ error: `Your team has already completed the "${grp.group_name}" pool for this tile.` });
        }
      }
    }

    try {
      const imageData = fs.readFileSync(req.file.path).toString('base64');
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: imageData } },
            { type: 'text', text: `This is an Old School RuneScape screenshot. Your job is to find the code word "${event.code_word}" (case-insensitive) anywhere in this image.\n\nOSRS uses a small pixel/bitmap font in the chat box — look carefully at the bottom-left chat area where the player would have typed this word. It will appear as part of a chat message like "PlayerName: ${event.code_word}". The pixel font can make letters look slightly blocky or unusual, so look carefully.\n\nAlso check any other visible text: overlays, notifications, item names, or anywhere on screen.\n\nReply with exactly "YES" or "NO" followed by a brief explanation of where you saw it (or why you didn't).` }
          ]
        }]
      });

      const answer = response.content[0].text.trim();
      if (!answer.toUpperCase().startsWith('YES')) {
        cleanup();
        return res.status(400).json({
          error: `Code word "${event.code_word}" not found in your screenshot. Make sure it is visible (e.g., type it in chat before taking the screenshot).`,
          detail: answer
        });
      }
    } catch (err) {
      console.error('Claude vision error:', err.message);
      cleanup();
      return res.status(500).json({ error: 'Screenshot verification failed — please try again.' });
    }

    const screenshotPath = 'uploads/' + path.basename(req.file.path);
    const result = db.run(`
      INSERT INTO submissions (event_id, tile_id, tile_item_id, team, player_name, screenshot_path, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `, [req.params.id, tileItem.tile_id, tile_item_id, teamNum, player_name.trim(), screenshotPath]);

    broadcast(req.params.id);
    res.json({ ok: true, submissionId: result.lastInsertRowid });
  });

  router.get('/events/:id/timer', (req, res) => {
    const ev = db.get('SELECT timer_end, timer_remaining_ms, timer_running FROM events WHERE id = ?', [req.params.id]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    res.json({ event_id: Number(req.params.id), timer_end: ev.timer_end, timer_remaining_ms: ev.timer_remaining_ms, timer_running: ev.timer_running ? 1 : 0 });
  });

  return router;
};
