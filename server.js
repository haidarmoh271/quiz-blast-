const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// AI Key Endpoint — يمرر المفتاح من Railway environment variable
app.get('/ai-key', (req, res) => {
  const key = process.env.COHERE_API_KEY || '';
  if(!key) return res.status(404).json({error: 'GROQ_API_KEY not set'});
  res.json({key});
});

// QR Endpoint
app.get('/qr', async (req, res) => {
  const url = req.query.url || '';
  if (!url) return res.status(400).send('missing url');
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg', width: 200, margin: 2,
      color: { dark: '#111111', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) { res.status(500).send('QR error'); }
});

// ══════════════════════════
//  Data
// ══════════════════════════
let rooms = {};

const TEAM_COLORS = [
  {name:'أحمر',    color:'#ef4444', emoji:'🔴'},
  {name:'أزرق',    color:'#3b82f6', emoji:'🔵'},
  {name:'أخضر',    color:'#22c55e', emoji:'🟢'},
  {name:'أصفر',    color:'#eab308', emoji:'🟡'},
  {name:'بنفسجي',  color:'#a855f7', emoji:'🟣'},
  {name:'برتقالي', color:'#f97316', emoji:'🟠'},
  {name:'وردي',    color:'#ec4899', emoji:'🩷'},
  {name:'فيروزي',  color:'#06b6d4', emoji:'🩵'},
  {name:'بيج',     color:'#d97706', emoji:'🟤'},
  {name:'رمادي',   color:'#6b7280', emoji:'⚫'},
];

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getPlayerList(room) {
  return Object.entries(room.players).map(([sid, p]) => ({
    socketId: sid, name: p.name, team: p.team || '', score: p.score
  }));
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRoomsSnapshot() {
  return Object.entries(rooms).map(([code, room]) => ({
    code,
    title: room.quiz?.title || 'بدون عنوان',
    state: room.state,
    gameMode: room.gameMode || 'solo',
    playerCount: Object.keys(room.players).length,
    players: Object.entries(room.players).map(([sid, p]) => ({
      socketId: sid, name: p.name, team: p.team || '', score: p.score
    })),
    currentQ: room.currentQ,
    totalQ: room.quiz?.questions?.length || 0,
  }));
}

// ══════════════════════════
//  Game Logic
// ══════════════════════════
function nextQuestion(code) {
  const room = rooms[code];
  if (!room) return;
  room.currentQ++;
  if (room.currentQ >= room.quiz.questions.length) return endGame(code);
  room.state = 'question';
  const q = room.quiz.questions[room.currentQ];
  const total = room.quiz.questions.length;

  // أرسل للمضيف بالإجابة الصحيحة
  io.to(room.host).emit('host:question', {
    index: room.currentQ, total,
    question: q.question, answers: q.answers,
    correct: q.correct, time: q.time, image: q.image || null,
  });

  // أرسل للاعبين بترتيب عشوائي مختلف لكل لاعب (anti-cheat)
  Object.entries(room.players).forEach(([sid, player]) => {
    const indices = shuffleArray([0,1,2,3].slice(0, q.answers.length));
    const shuffledAnswers = indices.map(i => q.answers[i]);
    player.shuffleMap = player.shuffleMap || {};
    player.shuffleMap[room.currentQ] = indices;
    io.to(sid).emit('game:question', {
      index: room.currentQ, total,
      question: q.question, answers: shuffledAnswers,
      time: q.time, image: q.image || null,
    });
  });
}

function showResults(code) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'leaderboard';
  const q = room.quiz.questions[room.currentQ];

  const stats = q.answers.map((_, i) => ({
    count: Object.values(room.players).filter(
      p => p.answers[room.currentQ]?.answerIndex === i
    ).length,
  }));

  const leaderboard = Object.values(room.players)
    .sort((a, b) => b.score - a.score).slice(0, 5)
    .map(p => ({ name: p.name, team: p.team||'', score: p.score }));

  // أرسل لكل لاعب نتيجته عند showResults
  Object.entries(room.players).forEach(([sid, player]) => {
    const ans = player.answers[room.currentQ];
    io.to(sid).emit('player:answerResult', {
      correct: ans ? ans.correct : false,
      points: ans ? ans.points : 0
    });
  });

  io.to(code).emit('game:results', {
    correct: q.correct, stats, leaderboard,
    isLast: room.currentQ + 1 >= room.quiz.questions.length,
  });
}

function endGame(code) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'finished';
  const final = Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i+1, name: p.name, team: p.team||'', score: p.score }));

  // نقاط الفرق
  let teamScores = null;
  if (room.gameMode === 'team' && room.teams && room.teams.length) {
    teamScores = {};
    room.teams.forEach(t => { teamScores[t.name] = { score:0, color:t.color, emoji:t.emoji }; });
    Object.values(room.players).forEach(p => {
      if (p.team && teamScores[p.team]) teamScores[p.team].score += p.score;
    });
  }

  io.to(code).emit('game:end', { final, teamScores });
  io.to('admins').emit('admin:rooms', getRoomsSnapshot());
  setTimeout(() => delete rooms[code], 10 * 60 * 1000);
}

// ══════════════════════════
//  Socket Events
// ══════════════════════════
io.on('connection', socket => {

  // ── Host ──
  socket.on('host:create', ({ quiz, gameMode, teamNames }) => {
    const code = generateCode();
    const teams = (teamNames||[]).map((name, i) => ({
      name: name || TEAM_COLORS[i]?.name || ('فريق '+(i+1)),
      color: TEAM_COLORS[i]?.color || '#fff',
      emoji: TEAM_COLORS[i]?.emoji || '⚪',
    }));
    rooms[code] = {
      host: socket.id, players: {}, quiz,
      gameMode: gameMode||'solo', teams,
      state: 'lobby', currentQ: -1, answerTimes: {}
    };
    socket.join(code);
    socket.emit('host:created', { code, mode: gameMode||'solo', teams });
    io.to('admins').emit('admin:rooms', getRoomsSnapshot());
  });

  socket.on('host:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    nextQuestion(code);
    io.to('admins').emit('admin:rooms', getRoomsSnapshot());
  });

  socket.on('host:showResults', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    showResults(code);
  });

  socket.on('host:next', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.currentQ + 1 >= room.quiz.questions.length) endGame(code);
    else nextQuestion(code);
  });

  socket.on('host:skipQuestion', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.currentQ + 1 >= room.quiz.questions.length) endGame(code);
    else nextQuestion(code);
  });

  socket.on('host:renamePlayer', ({ code, socketId, newName }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.players[socketId]) {
      room.players[socketId].name = newName;
      io.to(socketId).emit('player:renamed', { newName });
      io.to(room.host).emit('host:playerList', { players: getPlayerList(room) });
    }
  });

  socket.on('host:kickPlayer', ({ code, socketId }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.players[socketId]) {
      io.to(socketId).emit('player:kicked');
      delete room.players[socketId];
      io.to(room.host).emit('host:playerList', { players: getPlayerList(room) });
      io.to(code).emit('room:update', { players: getPlayerList(room) });
    }
  });

  // ── Player ──
  socket.on('player:join', ({ code, name, team }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'الكود غير صحيح');
    if (room.state !== 'lobby') return socket.emit('error', 'اللعبة بدأت بالفعل');
    room.players[socket.id] = { name, team: team||'', score: 0, answers: [], shuffleMap: {} };
    socket.join(code);
    socket.data.code = code;
    socket.emit('player:joined', { name, team: team||'' });
    if (room.gameMode === 'team' && room.teams) {
      socket.emit('room:teams', { teams: room.teams });
    }
    io.to(room.host).emit('host:playerList', { players: getPlayerList(room) });
    io.to(code).emit('room:update', { players: getPlayerList(room) });
    io.to('admins').emit('admin:rooms', getRoomsSnapshot());
  });

  socket.on('player:answer', ({ code, answerIndex, timeLeft }) => {
    const room = rooms[code];
    if (!room || room.state !== 'question') return;
    const player = room.players[socket.id];
    if (!player || player.answers[room.currentQ] !== undefined) return;
    const q = room.quiz.questions[room.currentQ];

    // ترجمة الترتيب المخلوط للإجابة الحقيقية
    let realIndex = answerIndex;
    if (player.shuffleMap && player.shuffleMap[room.currentQ]) {
      realIndex = player.shuffleMap[room.currentQ][answerIndex];
    }

    const correct = realIndex === q.correct;
    const safeTimeLeft = Math.max(0, Math.min(timeLeft || 0, q.time));
    const points = correct ? Math.round(500 + (safeTimeLeft / q.time) * 500) : 0;
    player.score += points;
    player.answers[room.currentQ] = { answerIndex: realIndex, correct, points };

    // Anti-cheat
    if (!room.answerTimes[room.currentQ]) room.answerTimes[room.currentQ] = [];
    const now = Date.now();
    room.answerTimes[room.currentQ].push({ name: player.name, time: now, correct });
    const suspicious = room.answerTimes[room.currentQ].filter(a =>
      Math.abs(a.time - now) < 1000
    );
    if (suspicious.length >= 3) {
      io.to(room.host).emit('host:suspiciousActivity', {
        message: `⚠️ ${suspicious.length} لاعبين أجابوا في نفس الوقت!`,
        players: suspicious.map(a => a.name),
      });
    }

    const answeredCount = Object.values(room.players).filter(
      p => p.answers[room.currentQ] !== undefined
    ).length;
    io.to(room.host).emit('host:answeredCount', {
      count: answeredCount, total: Object.keys(room.players).length,
    });
  });

  // ── Admin ──
  socket.on('admin:subscribe', ({ pass }) => {
    if (pass !== '120') return socket.emit('admin:error', 'كلمة السر غلط');
    socket.join('admins');
    socket.emit('admin:rooms', getRoomsSnapshot());
  });

  socket.on('admin:getRooms', ({ pass }) => {
    if (pass !== '120') return socket.emit('admin:error', 'كلمة السر غلط');
    socket.emit('admin:rooms', getRoomsSnapshot());
  });

  socket.on('admin:kickPlayer', ({ pass, code, socketId }) => {
    if (pass !== '120') return;
    const room = rooms[code];
    if (!room || !room.players[socketId]) return;
    io.to(socketId).emit('player:kicked');
    delete room.players[socketId];
    io.to(room.host).emit('host:playerList', { players: getPlayerList(room) });
    io.to(code).emit('room:update', { players: getPlayerList(room) });
    socket.emit('admin:rooms', getRoomsSnapshot());
  });

  socket.on('admin:closeRoom', ({ pass, code }) => {
    if (pass !== '120') return;
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit('player:kicked');
    delete rooms[code];
    socket.emit('admin:rooms', getRoomsSnapshot());
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (code && rooms[code] && rooms[code].players[socket.id]) {
      delete rooms[code].players[socket.id];
      io.to(code).emit('room:update', { players: getPlayerList(rooms[code]) });
      if (rooms[code].host) {
        io.to(rooms[code].host).emit('host:playerList', { players: getPlayerList(rooms[code]) });
      }
      io.to('admins').emit('admin:rooms', getRoomsSnapshot());
    }
  });
});

server.listen(PORT, () => console.log(`🎮 QuizBlast running on port ${PORT}`));
