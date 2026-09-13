const express = require('express');
const { db } = require('../database');

module.exports = function makeAdminRouter(broadcast, broadcastTimer) {
  const router = express.Router();

  router.use((req, res, next) => {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) return next();
    if (req.headers['x-admin-password'] !== password) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // ── Gamemodes ────────────────────────────────────────────
  router.get('/gamemodes', (req, res) => {
    res.json(db.all('SELECT * FROM gamemodes ORDER BY created_at DESC'));
  });

  router.post('/events/:id/save-as-gamemode', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    const tiles = db.all('SELECT * FROM tiles WHERE event_id = ? ORDER BY row, col', [req.params.id]);
    if (!tiles.length) return res.status(400).json({ error: 'No tiles on this board to save' });
    const save = db.transaction(() => {
      const r = db.run('INSERT INTO gamemodes (name) VALUES (?)', [name.trim()]);
      const gamemodeId = r.lastInsertRowid;
      for (const tile of tiles) {
        const tr = db.run(
          'INSERT INTO gamemode_tiles (gamemode_id, row, col, tile_name) VALUES (?, ?, ?, ?)',
          [gamemodeId, tile.row, tile.col, tile.tile_name]
        );
        const gtId = tr.lastInsertRowid;
        const groups = db.all('SELECT * FROM tile_item_groups WHERE tile_id = ? ORDER BY display_order', [tile.id]);
        const groupIdMap = {};
        for (const g of groups) {
          const gr = db.run(
            'INSERT INTO gamemode_tile_item_groups (tile_id, group_name, target_count, display_order) VALUES (?, ?, ?, ?)',
            [gtId, g.group_name, g.target_count, g.display_order]
          );
          groupIdMap[g.id] = gr.lastInsertRowid;
        }
        const items = db.all('SELECT * FROM tile_items WHERE tile_id = ?', [tile.id]);
        for (const item of items) {
          const newGroupId = item.group_id ? (groupIdMap[item.group_id] || null) : null;
          db.run(
            'INSERT INTO gamemode_tile_items (tile_id, item_name, quantity, wiki_image, group_id) VALUES (?, ?, ?, ?, ?)',
            [gtId, item.item_name, item.quantity, item.wiki_image, newGroupId]
          );
        }
      }
      return gamemodeId;
    });
    try {
      const id = save();
      res.json({ id, name: name.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Events ──────────────────────────────────────────────
  router.get('/events', (req, res) => {
    const events = db.all('SELECT * FROM events ORDER BY created_at DESC');
    res.json(events.map(ev => ({
      ...ev,
      teams: db.all('SELECT team_number, team_name FROM event_teams WHERE event_id = ? ORDER BY team_number', [ev.id])
    })));
  });

  router.post('/events', (req, res) => {
    const { name, code_word, team1_name, team2_name, gamemode_id, game_type } = req.body;
    if (!name || !code_word) return res.status(400).json({ error: 'name and code_word required' });
    const result = db.run(
      'INSERT INTO events (name, code_word, team1_name, team2_name, game_type) VALUES (?, ?, ?, ?, ?)',
      [name, code_word, team1_name || 'Team 1', team2_name || 'Team 2', game_type || 'bingo']
    );
    const eventId = result.lastInsertRowid;
    db.run('INSERT INTO event_teams (event_id, team_number, team_name) VALUES (?, 1, ?)', [eventId, team1_name || 'Team 1']);
    db.run('INSERT INTO event_teams (event_id, team_number, team_name) VALUES (?, 2, ?)', [eventId, team2_name || 'Team 2']);

    if (gamemode_id) {
      const gmTiles = db.all('SELECT * FROM gamemode_tiles WHERE gamemode_id = ? ORDER BY row, col', [gamemode_id]);
      for (const gmt of gmTiles) {
        const tr = db.run(
          'INSERT INTO tiles (event_id, row, col, tile_name) VALUES (?, ?, ?, ?)',
          [eventId, gmt.row, gmt.col, gmt.tile_name]
        );
        const tileId = tr.lastInsertRowid;
        const groups = db.all('SELECT * FROM gamemode_tile_item_groups WHERE tile_id = ? ORDER BY display_order', [gmt.id]);
        const groupIdMap = {};
        for (const g of groups) {
          const gr = db.run(
            'INSERT INTO tile_item_groups (tile_id, group_name, target_count, display_order) VALUES (?, ?, ?, ?)',
            [tileId, g.group_name, g.target_count, g.display_order]
          );
          groupIdMap[g.id] = gr.lastInsertRowid;
        }
        const items = db.all('SELECT * FROM gamemode_tile_items WHERE tile_id = ?', [gmt.id]);
        for (const item of items) {
          const newGroupId = item.group_id ? (groupIdMap[item.group_id] || null) : null;
          db.run(
            'INSERT INTO tile_items (tile_id, item_name, quantity, wiki_image, group_id) VALUES (?, ?, ?, ?, ?)',
            [tileId, item.item_name, item.quantity, item.wiki_image, newGroupId]
          );
        }
      }
    }

    res.json({ id: eventId });
  });

  router.patch('/events/:id', (req, res) => {
    const { status, code_word, name, rules, teams } = req.body;
    const event = db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (name) db.run('UPDATE events SET name = ? WHERE id = ?', [name, req.params.id]);
    if (status) db.run('UPDATE events SET status = ? WHERE id = ?', [status, req.params.id]);
    if (code_word) db.run('UPDATE events SET code_word = ? WHERE id = ?', [code_word, req.params.id]);
    if (rules !== undefined) db.run('UPDATE events SET rules = ? WHERE id = ?', [rules || null, req.params.id]);
    if (teams && Array.isArray(teams)) {
      for (const t of teams) {
        db.run('UPDATE event_teams SET team_name = ? WHERE event_id = ? AND team_number = ?',
          [(t.team_name || '').trim() || `Team ${t.team_number}`, req.params.id, t.team_number]);
      }
    }
    broadcast(req.params.id);
    res.json({ ok: true });
  });

  // ── Teams ────────────────────────────────────────────────

  router.get('/events/:id/teams', (req, res) => {
    res.json(db.all('SELECT * FROM event_teams WHERE event_id = ? ORDER BY team_number', [req.params.id]));
  });

  router.post('/events/:id/teams', (req, res) => {
    const { team_name } = req.body;
    const existing = db.all('SELECT team_number FROM event_teams WHERE event_id = ? ORDER BY team_number', [req.params.id]);
    const nextNum = existing.length ? Math.max(...existing.map(t => t.team_number)) + 1 : 1;
    const tname = (team_name || '').trim() || `Team ${nextNum}`;
    try {
      db.run('INSERT INTO event_teams (event_id, team_number, team_name) VALUES (?, ?, ?)', [req.params.id, nextNum, tname]);
      broadcast(req.params.id);
      res.json({ team_number: nextNum, team_name: tname });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/events/:id/teams/:teamNum', (req, res) => {
    const teamNum = parseInt(req.params.teamNum);
    const hasMembers = db.get('SELECT COUNT(*) as c FROM team_members WHERE event_id = ? AND team = ?', [req.params.id, teamNum]);
    const hasSubs = db.get("SELECT COUNT(*) as c FROM submissions WHERE event_id = ? AND team = ? AND status != 'rejected'", [req.params.id, teamNum]);
    if ((hasMembers?.c || 0) > 0 || (hasSubs?.c || 0) > 0) {
      return res.status(400).json({ error: 'Cannot remove a team that has players or submissions' });
    }
    db.run('DELETE FROM event_teams WHERE event_id = ? AND team_number = ?', [req.params.id, teamNum]);
    broadcast(req.params.id);
    res.json({ ok: true });
  });

  // ── Tiles ────────────────────────────────────────────────

  router.post('/events/:id/tiles', (req, res) => {
    const { row, col, tile_name, items = [], groups = [] } = req.body;
    if (row === undefined || col === undefined || !tile_name) {
      return res.status(400).json({ error: 'row, col, and tile_name required' });
    }
    if (!items.length && !groups.length) {
      return res.status(400).json({ error: 'At least one item or pool required' });
    }

    const saveTile = db.transaction((eventId, row, col, tile_name, items, groups) => {
      const existing = db.get('SELECT id FROM tiles WHERE event_id = ? AND row = ? AND col = ?', [eventId, row, col]);
      let tileId;

      if (existing) {
        tileId = existing.id;
        db.run('UPDATE tiles SET tile_name = ? WHERE id = ?', [tile_name, tileId]);

        // ── Individual items (group_id IS NULL) ──────────────────
        const exItems = db.all('SELECT id FROM tile_items WHERE tile_id = ? AND group_id IS NULL', [tileId]);
        const exItemIds = new Set(exItems.map(i => i.id));
        const keptItemIds = new Set(items.filter(i => i.id).map(i => Number(i.id)));
        for (const ex of exItems) {
          if (!keptItemIds.has(ex.id)) {
            const hs = db.get('SELECT COUNT(*) as c FROM submissions WHERE tile_item_id = ?', [ex.id]);
            if (!(hs && hs.c > 0)) db.run('DELETE FROM tile_items WHERE id = ?', [ex.id]);
          }
        }
        for (const item of items) {
          const name = (item.name || '').trim();
          const qty = Math.max(1, parseInt(item.qty) || 1);
          const wiki = (item.wiki_image || '').trim() || null;
          if (!name) continue;
          if (item.id && exItemIds.has(Number(item.id))) {
            db.run('UPDATE tile_items SET item_name = ?, quantity = ?, wiki_image = ? WHERE id = ?', [name, qty, wiki, Number(item.id)]);
          } else {
            db.run('INSERT INTO tile_items (tile_id, item_name, quantity, wiki_image) VALUES (?, ?, ?, ?)', [tileId, name, qty, wiki]);
          }
        }

        // ── Groups ───────────────────────────────────────────────
        const exGroups = db.all('SELECT id FROM tile_item_groups WHERE tile_id = ?', [tileId]);
        const exGroupIds = new Set(exGroups.map(g => g.id));
        const keptGroupIds = new Set(groups.filter(g => g.id).map(g => Number(g.id)));
        for (const eg of exGroups) {
          if (!keptGroupIds.has(eg.id)) {
            const gItems = db.all('SELECT id FROM tile_items WHERE group_id = ?', [eg.id]);
            let safe = true;
            for (const gi of gItems) {
              const hs = db.get('SELECT COUNT(*) as c FROM submissions WHERE tile_item_id = ?', [gi.id]);
              if (hs && hs.c > 0) { safe = false; break; }
            }
            if (safe) {
              db.run('DELETE FROM tile_items WHERE group_id = ?', [eg.id]);
              db.run('DELETE FROM tile_item_groups WHERE id = ?', [eg.id]);
            }
          }
        }
        groups.forEach((g, gIdx) => {
          let groupId;
          if (g.id && exGroupIds.has(Number(g.id))) {
            groupId = Number(g.id);
            db.run('UPDATE tile_item_groups SET group_name = ?, target_count = ?, display_order = ? WHERE id = ?',
              [g.group_name, g.target_count, gIdx, groupId]);
          } else {
            const r = db.run('INSERT INTO tile_item_groups (tile_id, group_name, target_count, display_order) VALUES (?, ?, ?, ?)',
              [tileId, g.group_name, g.target_count, gIdx]);
            groupId = r.lastInsertRowid;
          }
          const exGI = db.all('SELECT id FROM tile_items WHERE group_id = ?', [groupId]);
          const exGIIds = new Set(exGI.map(i => i.id));
          const keptGIIds = new Set(g.items.filter(i => i.id).map(i => Number(i.id)));
          for (const ex of exGI) {
            if (!keptGIIds.has(ex.id)) {
              const hs = db.get('SELECT COUNT(*) as c FROM submissions WHERE tile_item_id = ?', [ex.id]);
              if (!(hs && hs.c > 0)) db.run('DELETE FROM tile_items WHERE id = ?', [ex.id]);
            }
          }
          for (const item of g.items) {
            const name = (item.name || '').trim();
            const wiki = (item.wiki_image || '').trim() || null;
            if (!name) continue;
            if (item.id && exGIIds.has(Number(item.id))) {
              db.run('UPDATE tile_items SET item_name = ?, wiki_image = ?, group_id = ? WHERE id = ?', [name, wiki, groupId, Number(item.id)]);
            } else {
              db.run('INSERT INTO tile_items (tile_id, item_name, quantity, wiki_image, group_id) VALUES (?, ?, 1, ?, ?)', [tileId, name, wiki, groupId]);
            }
          }
        });

      } else {
        const r = db.run('INSERT INTO tiles (event_id, row, col, tile_name) VALUES (?, ?, ?, ?)', [eventId, row, col, tile_name]);
        tileId = r.lastInsertRowid;
        for (const item of items) {
          const name = (item.name || '').trim();
          const qty = Math.max(1, parseInt(item.qty) || 1);
          const wiki = (item.wiki_image || '').trim() || null;
          if (name) db.run('INSERT INTO tile_items (tile_id, item_name, quantity, wiki_image) VALUES (?, ?, ?, ?)', [tileId, name, qty, wiki]);
        }
        groups.forEach((g, gIdx) => {
          const r = db.run('INSERT INTO tile_item_groups (tile_id, group_name, target_count, display_order) VALUES (?, ?, ?, ?)',
            [tileId, g.group_name, g.target_count, gIdx]);
          const groupId = r.lastInsertRowid;
          for (const item of g.items) {
            const name = (item.name || '').trim();
            const wiki = (item.wiki_image || '').trim() || null;
            if (name) db.run('INSERT INTO tile_items (tile_id, item_name, quantity, wiki_image, group_id) VALUES (?, ?, 1, ?, ?)', [tileId, name, wiki, groupId]);
          }
        });
      }
      return tileId;
    });

    const tileId = saveTile(req.params.id, row, col, tile_name, items, groups);
    broadcast(req.params.id);
    res.json({ tileId });
  });

  router.delete('/events/:id/tiles/:tileId', (req, res) => {
    const hasSubs = db.get('SELECT COUNT(*) as c FROM submissions WHERE tile_id = ?', [req.params.tileId]);
    if (hasSubs && hasSubs.c > 0) {
      return res.status(400).json({ error: 'Cannot delete a tile that has submissions. Remove the submissions first.' });
    }
    db.run('DELETE FROM tile_items WHERE tile_id = ?', [req.params.tileId]);
    db.run('DELETE FROM tile_item_groups WHERE tile_id = ?', [req.params.tileId]);
    db.run('DELETE FROM tiles WHERE id = ?', [req.params.tileId]);
    broadcast(req.params.id);
    res.json({ ok: true });
  });

  // ── Roster ───────────────────────────────────────────────

  router.get('/events/:id/members', (req, res) => {
    res.json(db.all('SELECT * FROM team_members WHERE event_id = ? ORDER BY team, player_name', [req.params.id]));
  });

  router.post('/events/:id/members', (req, res) => {
    const { player_name, team } = req.body;
    if (!player_name || !team) return res.status(400).json({ error: 'player_name and team required' });
    const validTeam = db.get('SELECT id FROM event_teams WHERE event_id = ? AND team_number = ?', [req.params.id, team]);
    if (!validTeam) return res.status(400).json({ error: 'Invalid team number for this event' });
    try {
      const result = db.run(
        'INSERT INTO team_members (event_id, team, player_name) VALUES (?, ?, ?)',
        [req.params.id, team, player_name.trim()]
      );
      res.json({ id: result.lastInsertRowid });
    } catch (err) {
      res.status(400).json({ error: 'Player already on a team for this event' });
    }
  });

  router.delete('/events/:id/members/:memberId', (req, res) => {
    db.run('DELETE FROM team_members WHERE id = ? AND event_id = ?', [req.params.memberId, req.params.id]);
    res.json({ ok: true });
  });

  // ── Submissions ───────────────────────────────────────────

  router.get('/events/:id/submissions', (req, res) => {
    const subs = db.all(`
      SELECT s.*, t.tile_name, ti.item_name, tig.group_name,
             et.team_name
      FROM submissions s
      JOIN tiles t ON t.id = s.tile_id
      JOIN tile_items ti ON ti.id = s.tile_item_id
      LEFT JOIN tile_item_groups tig ON tig.id = ti.group_id
      LEFT JOIN event_teams et ON et.event_id = s.event_id AND et.team_number = s.team
      WHERE s.event_id = ?
      ORDER BY s.created_at DESC
    `, [req.params.id]);
    res.json(subs);
  });

  router.patch('/submissions/:submissionId', (req, res) => {
    const { status, rejection_reason } = req.body;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    const sub = db.get('SELECT * FROM submissions WHERE id = ?', [req.params.submissionId]);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    db.run('UPDATE submissions SET status = ?, rejection_reason = ? WHERE id = ?',
      [status, rejection_reason || null, req.params.submissionId]);
    broadcast(sub.event_id);
    res.json({ ok: true });
  });

  // ── Roulette Admin ────────────────────────────────────────
  router.get('/roulette/events/:id/double-down', (req, res) => {
    const rows = db.all(`
      SELECT dd.*, et.team_name
      FROM roulette_double_down dd
      LEFT JOIN event_teams et ON et.event_id = dd.event_id AND et.team_number = dd.team
      WHERE dd.event_id = ?
      ORDER BY dd.created_at DESC
    `, [req.params.id]);
    res.json(rows);
  });

  router.get('/roulette/events/:id/submissions', (req, res) => {
    const subs = db.all(`
      SELECT rs.*, rspin.wheel_tier, rspin.status as spin_status,
             rb.boss_name, rdrop.item_name as drop_name, rdrop.base_points,
             rspin.bonus_drop_id, bonus_drop.item_name as bonus_item,
             et.team_name
      FROM roulette_submissions rs
      JOIN roulette_spins rspin ON rspin.id = rs.spin_id
      JOIN roulette_bosses rb ON rb.id = rspin.boss_id
      LEFT JOIN roulette_boss_drops rdrop ON rdrop.id = rs.drop_id
      LEFT JOIN roulette_boss_drops bonus_drop ON bonus_drop.id = rspin.bonus_drop_id
      LEFT JOIN event_teams et ON et.event_id = rs.event_id AND et.team_number = rs.team
      WHERE rs.event_id = ?
      ORDER BY rs.created_at DESC
    `, [req.params.id]);
    res.json(subs);
  });

  router.patch('/roulette/submissions/:id', (req, res) => {
    const { status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    const sub = db.get('SELECT * FROM roulette_submissions WHERE id = ?', [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'Not found' });

    if (status === 'approved') {
      const spin = db.get('SELECT * FROM roulette_spins WHERE id = ?', [sub.spin_id]);
      const drop = db.get('SELECT * FROM roulette_boss_drops WHERE id = ?', [sub.drop_id]);
      const config = db.get('SELECT * FROM roulette_event_config WHERE event_id = ?', [sub.event_id])
        || { bonus_value: 100 };
      const basePoints = drop?.base_points || 0;
      const bonusPoints = spin && drop && spin.bonus_drop_id === sub.drop_id ? config.bonus_value : 0;

      const nowIso = new Date().toISOString();
      const dd = db.get(
        'SELECT * FROM roulette_double_down WHERE event_id = ? AND team = ? AND end_time > ? ORDER BY end_time DESC LIMIT 1',
        [sub.event_id, sub.team, nowIso]
      );
      const multiplier = dd ? 2 : 1;
      const total = (basePoints + bonusPoints) * multiplier;
      const ddNote = dd ? ' 🔥×2 Double Down' : '';

      db.run('UPDATE roulette_submissions SET status = ?, points_awarded = ?, bonus_points = ?, double_down = ? WHERE id = ?',
        [status, basePoints * multiplier, bonusPoints * multiplier, dd ? 1 : 0, sub.id]);
      db.run('UPDATE roulette_spins SET status = ? WHERE id = ?', ['completed', sub.spin_id]);
      db.run('INSERT INTO roulette_bank_log (event_id, team, amount, reason) VALUES (?, ?, ?, ?)',
        [sub.event_id, sub.team, total, `${drop?.item_name || 'Drop'} from boss${bonusPoints ? ` +${bonusPoints} bonus` : ''}${ddNote}`]);
    } else if (status === 'pending' && sub.status === 'approved') {
      // Unapprove: reverse the points and restore the spin to active
      const total = (sub.points_awarded || 0) + (sub.bonus_points || 0);
      db.run('INSERT INTO roulette_bank_log (event_id, team, amount, reason) VALUES (?, ?, ?, ?)',
        [sub.event_id, sub.team, -total, 'Submission unapproved']);
      db.run('UPDATE roulette_spins SET status = ? WHERE id = ?', ['active', sub.spin_id]);
      db.run('UPDATE roulette_submissions SET status = ?, points_awarded = 0, bonus_points = 0 WHERE id = ?',
        ['pending', sub.id]);
    } else {
      db.run('UPDATE roulette_submissions SET status = ? WHERE id = ?', [status, sub.id]);
    }

    broadcast(sub.event_id);
    res.json({ ok: true });
  });

  router.post('/roulette/events/:id/bank-adjust', (req, res) => {
    const { team, amount, reason } = req.body;
    if (!team || !amount || !reason) return res.status(400).json({ error: 'team, amount, reason required' });
    db.run('INSERT INTO roulette_bank_log (event_id, team, amount, reason) VALUES (?, ?, ?, ?)',
      [req.params.id, parseInt(team), parseInt(amount), reason]);
    broadcast(req.params.id);
    res.json({ ok: true });
  });

  router.patch('/roulette/events/:id/config', (req, res) => {
    const { starting_bank, respin_cost, bonus_value } = req.body;
    const existing = db.get('SELECT id FROM roulette_event_config WHERE event_id = ?', [req.params.id]);
    if (existing) {
      db.run('UPDATE roulette_event_config SET starting_bank = ?, respin_cost = ?, bonus_value = ? WHERE event_id = ?',
        [starting_bank ?? 500, respin_cost ?? 200, bonus_value ?? 100, req.params.id]);
    } else {
      db.run('INSERT INTO roulette_event_config (event_id, starting_bank, respin_cost, bonus_value) VALUES (?, ?, ?, ?)',
        [req.params.id, starting_bank ?? 500, respin_cost ?? 200, bonus_value ?? 100]);
    }
    res.json({ ok: true });
  });

  router.delete('/events/:id', (req, res) => {
    const id = req.params.id;
    if (!db.get('SELECT id FROM events WHERE id = ?', [id])) return res.status(404).json({ error: 'Event not found' });
    // cascade delete everything belonging to this event
    db.run('DELETE FROM submissions WHERE event_id = ?', [id]);
    db.run('DELETE FROM tile_items WHERE tile_id IN (SELECT id FROM tiles WHERE event_id = ?)', [id]);
    db.run('DELETE FROM tile_item_groups WHERE tile_id IN (SELECT id FROM tiles WHERE event_id = ?)', [id]);
    db.run('DELETE FROM tiles WHERE event_id = ?', [id]);
    db.run('DELETE FROM team_members WHERE event_id = ?', [id]);
    db.run('DELETE FROM event_teams WHERE event_id = ?', [id]);
    try { db.run('DELETE FROM roulette_submissions WHERE event_id = ?', [id]); } catch {}
    try { db.run('DELETE FROM roulette_spins WHERE event_id = ?', [id]); } catch {}
    try { db.run('DELETE FROM roulette_bank_log WHERE event_id = ?', [id]); } catch {}
    try { db.run('DELETE FROM roulette_event_config WHERE event_id = ?', [id]); } catch {}
    db.run('DELETE FROM events WHERE id = ?', [id]);
    res.json({ ok: true });
  });

  router.delete('/gamemodes/:id', (req, res) => {
    const id = req.params.id;
    if (!db.get('SELECT id FROM gamemodes WHERE id = ?', [id])) return res.status(404).json({ error: 'Gamemode not found' });
    db.run('DELETE FROM gamemode_tile_items WHERE tile_id IN (SELECT id FROM gamemode_tiles WHERE gamemode_id = ?)', [id]);
    db.run('DELETE FROM gamemode_tile_item_groups WHERE tile_id IN (SELECT id FROM gamemode_tiles WHERE gamemode_id = ?)', [id]);
    db.run('DELETE FROM gamemode_tiles WHERE gamemode_id = ?', [id]);
    db.run('DELETE FROM gamemodes WHERE id = ?', [id]);
    res.json({ ok: true });
  });

  // ── Boss Manager ────────────────────────────────────────────
  router.get('/roulette/bosses', (req, res) => {
    const bosses = db.all('SELECT * FROM roulette_bosses ORDER BY wheel_tier, boss_name');
    res.json(bosses.map(b => ({
      ...b,
      drops: db.all('SELECT * FROM roulette_boss_drops WHERE boss_id = ? ORDER BY base_points DESC', [b.id])
    })));
  });

  router.post('/roulette/bosses', (req, res) => {
    const { boss_name, wheel_tier } = req.body;
    if (!boss_name || !wheel_tier) return res.status(400).json({ error: 'boss_name and wheel_tier required' });
    try {
      const r = db.run('INSERT INTO roulette_bosses (boss_name, wheel_tier) VALUES (?, ?)', [boss_name.trim(), parseInt(wheel_tier)]);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch { res.status(400).json({ error: 'Boss name already exists' }); }
  });

  router.patch('/roulette/bosses/:id', (req, res) => {
    const { boss_name, wheel_tier } = req.body;
    const boss = db.get('SELECT * FROM roulette_bosses WHERE id = ?', [req.params.id]);
    if (!boss) return res.status(404).json({ error: 'Boss not found' });
    db.run('UPDATE roulette_bosses SET boss_name = ?, wheel_tier = ? WHERE id = ?',
      [boss_name ?? boss.boss_name, parseInt(wheel_tier ?? boss.wheel_tier), req.params.id]);
    res.json({ ok: true });
  });

  router.delete('/roulette/bosses/:id', (req, res) => {
    if (!db.get('SELECT id FROM roulette_bosses WHERE id = ?', [req.params.id])) return res.status(404).json({ error: 'Boss not found' });
    db.run('DELETE FROM roulette_boss_drops WHERE boss_id = ?', [req.params.id]);
    db.run('DELETE FROM roulette_bosses WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  router.post('/roulette/boss-drops', (req, res) => {
    const { boss_id, item_name, base_points, image_url } = req.body;
    if (!boss_id || !item_name) return res.status(400).json({ error: 'boss_id and item_name required' });
    try {
      const r = db.run('INSERT INTO roulette_boss_drops (boss_id, item_name, base_points, image_url) VALUES (?, ?, ?, ?)',
        [parseInt(boss_id), item_name.trim(), parseInt(base_points) || 0, image_url?.trim() || null]);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch { res.status(400).json({ error: 'Drop already exists for this boss' }); }
  });

  router.patch('/roulette/boss-drops/:id', (req, res) => {
    const { item_name, base_points, image_url } = req.body;
    const drop = db.get('SELECT * FROM roulette_boss_drops WHERE id = ?', [req.params.id]);
    if (!drop) return res.status(404).json({ error: 'Drop not found' });
    db.run('UPDATE roulette_boss_drops SET item_name = ?, base_points = ?, image_url = ? WHERE id = ?',
      [item_name ?? drop.item_name, parseInt(base_points ?? drop.base_points), image_url !== undefined ? (image_url?.trim() || null) : drop.image_url, req.params.id]);
    res.json({ ok: true });
  });

  router.delete('/roulette/boss-drops/:id', (req, res) => {
    if (!db.get('SELECT id FROM roulette_boss_drops WHERE id = ?', [req.params.id])) return res.status(404).json({ error: 'Drop not found' });
    db.run('DELETE FROM roulette_boss_drops WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // All unique wiki filenames + item→filename map for bingo tile editor autocomplete/auto-fill
  router.get('/wiki-filenames', (req, res) => {
    const prefix = 'https://oldschool.runescape.wiki/w/Special:FilePath/';
    const filenames = new Set();
    const itemMap = {};

    db.all("SELECT item_name, image_url FROM roulette_boss_drops WHERE image_url IS NOT NULL AND image_url != ''")
      .forEach(r => {
        let fn = null;
        if (r.image_url.startsWith(prefix)) {
          fn = r.image_url.slice(prefix.length);
        } else {
          // Handle direct /images/ URLs: extract last path component
          const m = r.image_url.match(/\/([^/]+\.png)(?:\?.*)?$/i);
          if (m) fn = m[1];
        }
        if (fn) {
          filenames.add(fn);
          if (r.item_name) itemMap[r.item_name.toLowerCase()] = fn;
        }
      });

    db.all("SELECT DISTINCT wiki_image FROM tile_items WHERE wiki_image IS NOT NULL AND wiki_image != ''")
      .forEach(r => filenames.add(r.wiki_image.trim()));
    db.all("SELECT DISTINCT wiki_image FROM gamemode_tile_items WHERE wiki_image IS NOT NULL AND wiki_image != ''")
      .forEach(r => filenames.add(r.wiki_image.trim()));

    res.json({
      filenames: [...filenames].sort((a, b) => a.localeCompare(b)),
      itemMap
    });
  });

  router.delete('/submissions/:submissionId', (req, res) => {
    const sub = db.get('SELECT * FROM submissions WHERE id = ?', [req.params.submissionId]);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    db.run('DELETE FROM submissions WHERE id = ?', [req.params.submissionId]);
    broadcast(sub.event_id);
    res.json({ ok: true });
  });

  // ── Event Timer ───────────────────────────────────────────────
  function getTimerState(eventId) {
    const ev = db.get('SELECT timer_end, timer_remaining_ms, timer_running FROM events WHERE id = ?', [eventId]);
    if (!ev) return null;
    return { event_id: eventId, timer_end: ev.timer_end, timer_remaining_ms: ev.timer_remaining_ms, timer_running: ev.timer_running ? 1 : 0 };
  }

  router.get('/events/:id/timer', (req, res) => {
    const state = getTimerState(Number(req.params.id));
    if (!state) return res.status(404).json({ error: 'Event not found' });
    res.json(state);
  });

  router.post('/events/:id/timer/set', (req, res) => {
    const eventId = Number(req.params.id);
    const ev = db.get('SELECT id FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const { days = 0, hours = 0, minutes = 0 } = req.body;
    const ms = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 * 1000;
    db.run('UPDATE events SET timer_remaining_ms = ?, timer_end = NULL, timer_running = 0 WHERE id = ?', [ms, eventId]);
    const state = getTimerState(eventId);
    if (broadcastTimer) broadcastTimer(eventId, state);
    res.json(state);
  });

  router.post('/events/:id/timer/start', (req, res) => {
    const eventId = Number(req.params.id);
    const ev = db.get('SELECT timer_remaining_ms, timer_running FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (ev.timer_running) return res.json(getTimerState(eventId));
    const remaining = ev.timer_remaining_ms || 0;
    const end = new Date(Date.now() + remaining).toISOString();
    db.run('UPDATE events SET timer_end = ?, timer_running = 1, timer_remaining_ms = ? WHERE id = ?', [end, remaining, eventId]);
    const state = getTimerState(eventId);
    if (broadcastTimer) broadcastTimer(eventId, state);
    res.json(state);
  });

  router.post('/events/:id/timer/stop', (req, res) => {
    const eventId = Number(req.params.id);
    const ev = db.get('SELECT timer_end, timer_running FROM events WHERE id = ?', [eventId]);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    let remaining = 0;
    if (ev.timer_running && ev.timer_end) {
      remaining = Math.max(0, new Date(ev.timer_end).getTime() - Date.now());
    }
    db.run('UPDATE events SET timer_running = 0, timer_remaining_ms = ?, timer_end = NULL WHERE id = ?', [remaining, eventId]);
    const state = getTimerState(eventId);
    if (broadcastTimer) broadcastTimer(eventId, state);
    res.json(state);
  });

  router.post('/events/:id/timer/clear', (req, res) => {
    const eventId = Number(req.params.id);
    db.run('UPDATE events SET timer_running = 0, timer_remaining_ms = NULL, timer_end = NULL WHERE id = ?', [eventId]);
    const state = getTimerState(eventId);
    if (broadcastTimer) broadcastTimer(eventId, state);
    res.json(state);
  });

  return router;
};
