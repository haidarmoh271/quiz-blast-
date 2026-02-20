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

// ══════════════════════════
//  QR Code Endpoint
// ══════════════════════════
app.get('/qr', async (req, res) => {
  const url = req.query.url || '';
  if (!url) return res.status(400).send('missing url');
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      width: 200,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

// ══════════════════════════
//  Game Logic
// ══════════════════════════
let rooms = {};

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getPlayerList(room) {
  return Object.values(room.players).map(p => ({ name: p.name, score: p.score }));
}

function nextQuestion(code) {
  const room = rooms[code];
  if (!room) return;
  room.currentQ++;
  room.state = 'question';
  const q = room.quiz.questions[room.currentQ];
  const total = room.quiz.questions.length;

  io.to(code).emit('game:question', {
    index: room.currentQ, total,
    question: q.question, answers: q.answers,
    time: q.time, image: q.image || null,
  });
  io.to(room.host).emit('host:question', {
    index: room.currentQ, total,
    question: q.question, answers: q.answers,
    correct: q.correct, time: q.time, image: q.image || null,
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
    .map(p => ({ name: p.name, score: p.score }));

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
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
  io.to(code).emit('game:end', { final });
  // Clean up after 10 minutes
  setTimeout(() => delete rooms[code], 10 * 60 * 1000);
}

io.on('connection', socket => {
  socket.on('host:create', ({ quiz }) => {
    const code = generateCode();
    rooms[code] = { host: socket.id, players: {}, quiz, state: 'lobby', currentQ: -1 };
    socket.join(code);
    socket.emit('host:created', { code });
  });

  socket.on('player:join', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'الكود غير صحيح');
    if (room.state !== 'lobby') return socket.emit('error', 'اللعبة بدأت بالفعل');
    room.players[socket.id] = { name, score: 0, answers: [] };
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('player:joined', { name });
    io.to(room.host).emit('host:playerList', { players: getPlayerList(room) });
    io.to(code).emit('room:update', { players: getPlayerList(room) });
  });

  socket.on('host:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = 'question';
    nextQuestion(code);
  });

  socket.on('player:answer', ({ code, answerIndex, timeLeft }) => {
    const room = rooms[code];
    if (!room || room.state !== 'question') return;
    const player = room.players[socket.id];
    if (!player || player.answers[room.currentQ] !== undefined) return;
    const q = room.quiz.questions[room.currentQ];
    const correct = answerIndex === q.correct;
    const points = correct ? Math.round(500 + (timeLeft / q.time) * 500) : 0;
    player.score += points;
    player.answers[room.currentQ] = { answerIndex, correct, points };
    socket.emit('player:answerResult', { correct, points });
    const answered = Object.values(room.players).filter(
      p => p.answers[room.currentQ] !== undefined
    ).length;
    io.to(room.host).emit('host:answeredCount', {
      count: answered, total: Object.keys(room.players).length,
    });
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

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (code && rooms[code]) {
      delete rooms[code].players[socket.id];
      io.to(code).emit('room:update', { players: getPlayerList(rooms[code]) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`🎮 QuizBlast running on port ${PORT}`);
});
