const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../database');

const client = new Anthropic();

const DATA_DIR = (() => {
  const preferred = process.env.DATA_DIR;
  if (preferred) { try { fs.mkdirSync(path.join(preferred, 'uploads'), { recursive: true }); return preferred; } catch {} }
  return path.join(__dirname, '..');
})();
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `r-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

function getBank(eventId, teamNum, startingBank) {
  const row = db.get('SELECT COALESCE(SUM(amount),0) as total FROM roulette_bank_log WHERE event_id = ? AND team = ?', [eventId, teamNum]);
  return startingBank + (row?.total || 0);
}

function getConfig(eventId) {
  return db.get('SELECT * FROM roulette_event_config WHERE event_id = ?', [eventId])
    || { starting_bank: 500, respin_cost: 200, bonus_value: 100 };
}

function getActiveDoubleDown(eventId, teamNum) {
  const now = new Date().toISOString();
  return db.get(
    'SELECT * FROM roulette_double_down WHERE event_id = ? AND team = ? AND end_time > ? ORDER BY end_time DESC LIMIT 1',
    [eventId, teamNum, now]
  );
}

module.exports = function makeRouletteRouter(broadcast, broadcastSpin) {
  const router = express.Router();

  // List all bosses with drops
  router.get('/bosses', (req, res) => {
    const bosses = db.all('SELECT * FROM roulette_bosses ORDER BY wheel_tier, id');
    res.json(bosses.map(b => ({
      ...b,
      drops: db.all('SELECT * FROM roulette_boss_drops WHERE boss_id = ? ORDER BY base_points DESC', [b.id])
    })));
  });

  // Full event state
  router.get('/events/:id/state', (req, res, next) => {
    try {
      const event = db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const config = getConfig(req.params.id);
      const teams = db.all('SELECT * FROM event_teams WHERE event_id = ? ORDER BY team_number', [req.params.id]);

      const teamData = teams.map(team => {
        const bank = getBank(req.params.id, team.team_number, config.starting_bank);

        const activeSpins = db.all(`
          SELECT rs.*, rb.boss_name, rb.wheel_tier as boss_tier,
                 rbd.item_name as bonus_item, rbd.base_points as bonus_base_pts,
                 rsub.status as sub_status, rsub.id as sub_id
          FROM roulette_spins rs
          JOIN roulette_bosses rb ON rb.id = rs.boss_id
          LEFT JOIN roulette_boss_drops rbd ON rbd.id = rs.bonus_drop_id
          LEFT JOIN roulette_submissions rsub ON rsub.spin_id = rs.id AND rsub.status = 'pending'
          WHERE rs.event_id = ? AND rs.team = ? AND rs.status = 'active'
        `, [req.params.id, team.team_number]);

        const completedCount = db.get(
          "SELECT COUNT(*) as c FROM roulette_spins WHERE event_id = ? AND team = ? AND status = 'completed'",
          [req.params.id, team.team_number]
        )?.c || 0;

        const dd = getActiveDoubleDown(req.params.id, team.team_number);
        return { ...team, bank, active_spins: activeSpins, completed_count: completedCount, double_down_end: dd?.end_time || null };
      });

      const history = db.all(`
        SELECT rs.id, rs.team, rs.wheel_tier, rs.spin_cost, rs.status, rs.created_at,
               rb.boss_name, rbd.item_name as bonus_item, rbd.base_points as bonus_pts,
               et.team_name,
               rsub.status as sub_status, rsub.points_awarded, rsub.bonus_points,
               rsub.player_name, rsub.double_down,
               rdrop.item_name as submitted_item, rdrop.image_url as submitted_image_url
        FROM roulette_spins rs
        JOIN roulette_bosses rb ON rb.id = rs.boss_id
        LEFT JOIN roulette_boss_drops rbd ON rbd.id = rs.bonus_drop_id
        JOIN event_teams et ON et.event_id = rs.event_id AND et.team_number = rs.team
        LEFT JOIN roulette_submissions rsub ON rsub.spin_id = rs.id AND rsub.status != 'rejected'
        LEFT JOIN roulette_boss_drops rdrop ON rdrop.id = rsub.drop_id
        WHERE rs.event_id = ? AND rs.status != 'abandoned'
        ORDER BY rs.created_at DESC
        LIMIT 60
      `, [req.params.id]);

      const members = db.all('SELECT team, player_name FROM team_members WHERE event_id = ? ORDER BY team, player_name', [req.params.id]);
      res.json({ event, config, teams: teamData, history, members });
    } catch (err) { next(err); }
  });

  // Spin a wheel
  router.post('/events/:id/spin', (req, res, next) => {
    try {
      const { team, wheel_tier } = req.body;
      if (!team || !wheel_tier) return res.status(400).json({ error: 'team and wheel_tier required' });
      const teamNum = parseInt(team);
      const tier = parseInt(wheel_tier);
      if (tier !== 1 && tier !== 2) return res.status(400).json({ error: 'wheel_tier must be 1 or 2' });

      const event = db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
      if (!event || event.status !== 'active') return res.status(400).json({ error: 'Event not active' });

      const validTeam = db.get('SELECT * FROM event_teams WHERE event_id = ? AND team_number = ?', [req.params.id, teamNum]);
      if (!validTeam) return res.status(400).json({ error: 'Invalid team' });

      const config = getConfig(req.params.id);

      const activeSpin = db.get(
        "SELECT * FROM roulette_spins WHERE event_id = ? AND team = ? AND wheel_tier = ? AND status = 'active'",
        [req.params.id, teamNum, tier]
      );
      const isRespin = !!activeSpin;
      const spinCost = isRespin ? config.respin_cost : 0;

      if (spinCost > 0) {
        const bank = getBank(req.params.id, teamNum, config.starting_bank);
        if (bank < spinCost) {
          return res.status(400).json({ error: `Not enough points. Need ${spinCost}, have ${bank}.` });
        }
        db.run("UPDATE roulette_spins SET status = 'abandoned' WHERE id = ?", [activeSpin.id]);
        db.run('INSERT INTO roulette_bank_log (event_id, team, amount, reason) VALUES (?, ?, ?, ?)',
          [req.params.id, teamNum, -spinCost, `Re-spin Wheel ${tier}`]);
      }

      const bosses = db.all('SELECT * FROM roulette_bosses WHERE wheel_tier = ?', [tier]);
      if (!bosses.length) return res.status(400).json({ error: 'No bosses configured for this tier' });

      const boss = bosses[Math.floor(Math.random() * bosses.length)];
      const drops = db.all('SELECT * FROM roulette_boss_drops WHERE boss_id = ?', [boss.id]);
      const bonusDrop = drops.length ? drops[Math.floor(Math.random() * drops.length)] : null;

      const result = db.run(
        'INSERT INTO roulette_spins (event_id, team, wheel_tier, boss_id, bonus_drop_id, spin_cost) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.id, teamNum, tier, boss.id, bonusDrop?.id || null, spinCost]
      );

      const bossIndex = bosses.findIndex(b => b.id === boss.id);
      const teamRow = db.get('SELECT team_name FROM event_teams WHERE event_id = ? AND team_number = ?', [req.params.id, teamNum]);
      const teamName = teamRow?.team_name || `Team ${teamNum}`;

      broadcast(req.params.id);
      if (broadcastSpin) broadcastSpin(req.params.id, {
        event_id: req.params.id,
        team: teamNum,
        team_name: teamName,
        wheel_tier: tier,
        boss_name: boss.boss_name,
        boss_index: bossIndex,
        boss_count: bosses.length,
        bosses: bosses.map(b => ({ id: b.id, boss_name: b.boss_name })),
        initiator_socket: req.body.socket_id || null,
      });

      res.json({
        spin_id: result.lastInsertRowid,
        boss,
        bonus_drop: bonusDrop,
        spin_cost: spinCost,
        is_respin: isRespin,
        boss_index: bossIndex,
        boss_count: bosses.length,
        bosses: bosses.map(b => ({ id: b.id, boss_name: b.boss_name })),
      });
    } catch (err) { next(err); }
  });

  // Submit a drop
  router.post('/events/:id/submit', upload.single('screenshot'), async (req, res) => {
    const { player_name, team, spin_id, drop_id } = req.body;
    const cleanup = () => { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} };

    if (!player_name || !team || !spin_id || !drop_id || !req.file) {
      cleanup();
      return res.status(400).json({ error: 'player_name, team, spin_id, drop_id, and screenshot are required' });
    }

    const teamNum = parseInt(team);
    const event = db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!event || event.status !== 'active') { cleanup(); return res.status(400).json({ error: 'Event not active' }); }

    const member = db.get(
      'SELECT id FROM team_members WHERE event_id = ? AND LOWER(player_name) = LOWER(?) AND team = ?',
      [req.params.id, player_name.trim(), teamNum]
    );
    if (!member) { cleanup(); return res.status(400).json({ error: `"${player_name}" is not on the roster for this team.` }); }

    const spin = db.get('SELECT * FROM roulette_spins WHERE id = ? AND event_id = ? AND team = ?', [spin_id, req.params.id, teamNum]);
    if (!spin || spin.status !== 'active') { cleanup(); return res.status(400).json({ error: 'No active spin found' }); }

    const drop = db.get('SELECT * FROM roulette_boss_drops WHERE id = ? AND boss_id = ?', [drop_id, spin.boss_id]);
    if (!drop) { cleanup(); return res.status(400).json({ error: 'Invalid drop for this boss' }); }

    const existing = db.get("SELECT id FROM roulette_submissions WHERE spin_id = ? AND status = 'pending'", [spin_id]);
    if (existing) { cleanup(); return res.status(400).json({ error: 'A submission is already pending for this boss. Wait for admin to review it.' }); }

    try {
      const imageData = fs.readFileSync(req.file.path).toString('base64');
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: imageData } },
          { type: 'text', text: `This is an Old School RuneScape screenshot. Does the text "${event.code_word}" appear anywhere in this image? Reply with exactly "YES" or "NO" followed by a brief explanation.` }
        ]}]
      });
      const answer = response.content[0].text.trim();
      if (!answer.toUpperCase().startsWith('YES')) {
        cleanup();
        return res.status(400).json({ error: `Code word "${event.code_word}" not found in screenshot.`, detail: answer });
      }
    } catch (err) {
      console.error('Claude vision error:', err.message);
      cleanup();
      return res.status(500).json({ error: 'Screenshot verification failed — please try again.' });
    }

    const screenshotPath = 'uploads/' + path.basename(req.file.path);
    db.run(
      'INSERT INTO roulette_submissions (spin_id, event_id, team, player_name, drop_id, screenshot_path) VALUES (?, ?, ?, ?, ?, ?)',
      [spin_id, req.params.id, teamNum, player_name.trim(), drop_id, screenshotPath]
    );

    broadcast(req.params.id);
    res.json({ ok: true });
  });

  // Activate Double Down Hour
  router.post('/events/:id/double-down', upload.single('screenshot'), async (req, res) => {
    const { team, player_name } = req.body;
    const cleanup = () => { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} };

    if (!team || !player_name || !req.file) {
      cleanup();
      return res.status(400).json({ error: 'team, player_name, and screenshot required' });
    }
    const teamNum = parseInt(team);

    const event = db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!event || event.status !== 'active') { cleanup(); return res.status(400).json({ error: 'Event not active' }); }

    const member = db.get(
      'SELECT id FROM team_members WHERE event_id = ? AND LOWER(player_name) = LOWER(?) AND team = ?',
      [req.params.id, player_name.trim(), teamNum]
    );
    if (!member) { cleanup(); return res.status(400).json({ error: `"${player_name}" is not on the roster for Team ${teamNum}.` }); }

    const existing = getActiveDoubleDown(req.params.id, teamNum);
    if (existing) { cleanup(); return res.status(400).json({ error: 'Double Down is already active for this team.' }); }

    const config = getConfig(req.params.id);
    const bank = getBank(req.params.id, teamNum, config.starting_bank);
    if (bank < 1000) { cleanup(); return res.status(400).json({ error: `Not enough points. Need 1000, have ${bank}.` }); }

    // Verify RSN appears in chatbox via Claude Vision
    try {
      const imageData = fs.readFileSync(req.file.path).toString('base64');
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: imageData } },
          { type: 'text', text: `This is an Old School RuneScape screenshot. Does the text "${player_name.trim()}" appear anywhere in this image? It may appear in the chatbox, interface, or anywhere on screen — look for it as part of a chat line like "${player_name.trim()}: " or just the name on its own. Reply with exactly "YES" or "NO" followed by a brief explanation.` }
        ]}]
      });
      const answer = response.content[0].text.trim();
      console.log(`Double Down vision check for "${player_name}": ${answer}`);
      if (!answer.toUpperCase().startsWith('YES')) {
        cleanup();
        return res.status(400).json({ error: `RSN "${player_name}" not found in the chatbox. Type anything in chat so your name is visible in the bottom-left, then screenshot.`, detail: answer });
      }
    } catch (err) {
      console.error('Claude vision error:', err.message);
      cleanup();
      return res.status(500).json({ error: 'Screenshot verification failed — please try again.' });
    }

    cleanup();
    const endTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.run('INSERT INTO roulette_bank_log (event_id, team, amount, reason) VALUES (?, ?, ?, ?)',
      [req.params.id, teamNum, -1000, `Double Down Hour purchased by ${player_name.trim()}`]);
    db.run('INSERT INTO roulette_double_down (event_id, team, activated_by, end_time) VALUES (?, ?, ?, ?)',
      [req.params.id, teamNum, player_name.trim(), endTime]);

    broadcast(req.params.id);
    res.json({ ok: true, end_time: endTime });
  });

  return router;
};
