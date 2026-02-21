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

// حروف الخيارات الثابتة للدلالة على الإجابة
const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

// AI Key Endpoint لـ Cohere
app.get('/ai-key', (req, res) => {
  const key = process.env.COHERE_API_KEY || '';
  if(!key) return res.status(404).json({error: 'COHERE_API_KEY not set'});
  res.json({key});
});

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

function generateCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

function getPlayerList(room) {
  return Object.entries(room.players).map(([sid, p]) => ({
    socketId: sid, name: p.name, team: p.team || '', score: p.score
  }));
}

function getRoomsSnapshot() {
  return Object.entries(rooms).map(([code, room]) => ({
    code,
    title: room.quiz?.title || 'بدون عنوان',
    state: room.state,
    gameMode: room.gameMode || 'solo',
    playerCount: Object.keys(room.players).length,
    players: getPlayerList(room),
    currentQ: room.currentQ,
    totalQ: room.quiz?.questions?.length || 0,
  }));
}

// ── Game Logic (بدون Shuffle) ──
function nextQuestion(code) {
  const room = rooms[code];
  if (!room) return;
  room.currentQ++;
  if (room.currentQ >= room.quiz.questions.length) return endGame(code);
  room.state = 'question';
  const q = room.quiz.questions[room.currentQ];
  const total = room.quiz.questions.length;

  // المضيف يستلم كل البيانات
  io.to(room.host).emit('host:question', {
    index: room.currentQ, total,
    question: q.question, answers: q.answers,
    letters: OPTION_LETTERS.slice(0, q.answers.length),
    correct: q.correct, time: q.time, image: q.image || null,
    video: q.video || null // دعم فيديو السؤال
  });

  // اللاعب يستلم الحروف فقط (A, B, C, D)
  io.to(code).emit('game:question', {
    index: room.currentQ,
    letters: OPTION_LETTERS.slice(0, q
