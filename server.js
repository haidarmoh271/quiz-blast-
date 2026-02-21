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

// ══════════════════════════
//  DOTS (بيت بيوت) LOGIC
// ══════════════════════════
let dotsRooms = {};

function getDotsPlayerList(room){
  return Object.entries(room.players).map(([sid,p])=>({
    socketId:sid, name:p.name, team:p.team, score:p.score, isLeader:p.isLeader
  }));
}

function checkBoxes(room, lineKey){
  const n = room.gridSize;
  const parts = lineKey.split('_');
  const type=parts[0], r=+parts[1], c=+parts[2];
  const newBoxes = [];
  if(type==='h'){
    // check box above (r-1,c) and below (r,c)
    [[r-1,c],[r,c]].forEach(([br,bc])=>{
      if(br<0||br>=n-1||bc<0||bc>=n-1) return;
      if(room.lines[`h_${br}_${bc}`] && room.lines[`h_${br+1}_${bc}`] &&
         room.lines[`v_${br}_${bc}`] && room.lines[`v_${br}_${bc+1}`]){
        const key=`${br}_${bc}`;
        if(!room.boxes[key]){ room.boxes[key]=room.currentTurn; newBoxes.push(key); }
      }
    });
  } else {
    // check box left (r,c-1) and right (r,c)
    [[r,c-1],[r,c]].forEach(([br,bc])=>{
      if(br<0||br>=n-1||bc<0||bc>=n-1) return;
      if(room.lines[`h_${br}_${bc}`] && room.lines[`h_${br+1}_${bc}`] &&
         room.lines[`v_${br}_${bc}`] && room.lines[`v_${br}_${bc+1}`]){
        const key=`${br}_${bc}`;
        if(!room.boxes[key]){ room.boxes[key]=room.currentTurn; newBoxes.push(key); }
      }
    });
  }
  return newBoxes;
}

function calcScores(room){
  const scores={red:0,blue:0};
  Object.values(room.boxes).forEach(t=>{ if(t==='red'||t==='blue') scores[t]++; });
  return scores;
}

function isGameComplete(room){
  const n=room.gridSize;
  const totalBoxes=(n-1)*(n-1);
  return Object.keys(room.boxes).length >= totalBoxes;
}

function dotsNextQuestion(code){
  const room = dotsRooms[code];
  if(!room) return;
  room.currentQ++;
  if(room.currentQ >= room.questions.length){ dotsEndGame(code); return; }
  room.state='question';
  room.answerTimes={};
  const q=room.questions[room.currentQ];
  const total=room.questions.length;
  // shuffle answers per player
  Object.entries(room.players).forEach(([sid,player])=>{
    const indices=shuffleArray([0,1,2,3].slice(0,q.answers.length));
    const shuffled=indices.map(i=>q.answers[i]);
    player.shuffleMap=player.shuffleMap||{};
    player.shuffleMap[room.currentQ]=indices;
    io.to(sid).emit('dots:question',{index:room.currentQ,total,question:q.question,answers:shuffled,time:q.time});
  });
  io.to(room.host).emit('dots:question',{index:room.currentQ,total,question:q.question,answers:q.answers,correct:q.correct,time:q.time});
}

function dotsShowResults(code){
  const room = dotsRooms[code];
  if(!room) return;
  room.state='results';
  const q=room.questions[room.currentQ];

  // الفائز = أول لاعب أجاب صح (أسرع وقت)
  let winPlayer = null;
  let winTime = Infinity;
  Object.entries(room.players).forEach(([sid,player])=>{
    const ans=player.answers[room.currentQ];
    if(ans && ans.correct && ans.answerTime < winTime){
      winTime = ans.answerTime;
      winPlayer = {sid, player};
    }
  });
  const winTeam = winPlayer ? winPlayer.player.team : null;
  const winName = winPlayer ? winPlayer.player.name : null;

  // notify players of their result
  Object.entries(room.players).forEach(([sid,player])=>{
    const ans=player.answers[room.currentQ];
    io.to(sid).emit('dots:answerResult',{correct:ans?ans.correct:false,points:ans?ans.points:0});
  });

  const scores=calcScores(room);
  const leaderboard=Object.values(room.players).sort((a,b)=>b.score-a.score).slice(0,5).map(p=>({name:p.name,team:p.team,score:p.score}));
  const canDrawLine=!!winTeam && !isGameComplete(room);
  room.pendingWinTeam=winTeam;
  room.pendingWinPlayerSid=winPlayer?.sid;

  io.to(code).emit('dots:results',{correct:q.correct,winTeam,winName,scores,leaderboard,canDrawLine});
  io.to(room.host).emit('dots:results',{correct:q.correct,winTeam,winName,scores,leaderboard,canDrawLine});

  // فقط اللاعب الأسرع يرسم الخط (مو القائد)
  if(canDrawLine && winPlayer){
    io.to(winPlayer.sid).emit('dots:canDrawLine',{team:winTeam,gridSize:room.gridSize});
  }
}

function dotsEndGame(code){
  const room=dotsRooms[code];
  if(!room) return;
  room.state='finished';
  const scores=calcScores(room);
  let winner='tie';
  if(scores.red>scores.blue) winner='red';
  else if(scores.blue>scores.red) winner='blue';
  io.to(code).emit('dots:gameEnd',{winner,scores});
  setTimeout(()=>delete dotsRooms[code], 10*60*1000);
}

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

  // ── Dots Game ──
  socket.on('dots:create', ({questions, gridSize})=>{
    const code=generateCode();
    dotsRooms[code]={
      host:socket.id, players:{}, questions, gridSize:gridSize||5,
      state:'lobby', currentQ:-1, lines:{}, boxes:{}, answerTimes:{},
      pendingWinTeam:null
    };
    socket.join('dots_'+code);
    socket.emit('dots:created',{code});
  });

  socket.on('dots:join',({code,name,team})=>{
    const room=dotsRooms[code];
    if(!room) return socket.emit('error','الكود غير صحيح');
    if(room.state!=='lobby') return socket.emit('error','اللعبة بدأت');
    const teamPlayers=Object.values(room.players).filter(p=>p.team===team);
    if(teamPlayers.length>=2) return socket.emit('error','الفريق ممتلئ!');
    const isLeader=teamPlayers.length===0;
    room.players[socket.id]={name,team,score:0,answers:[],isLeader,shuffleMap:{}};
    socket.join('dots_'+code);
    socket.data.dotsCode=code;
    socket.emit('dots:joined',{name,team,isLeader,gridSize:room.gridSize});
    io.to(room.host).emit('dots:playerList',{players:getDotsPlayerList(room)});
  });

  socket.on('dots:kick',({code,socketId})=>{
    const room=dotsRooms[code];
    if(!room||room.host!==socket.id) return;
    io.to(socketId).emit('dots:kicked');
    delete room.players[socketId];
    io.to(room.host).emit('dots:playerList',{players:getDotsPlayerList(room)});
  });

  socket.on('dots:start',({code})=>{
    const room=dotsRooms[code];
    if(!room||room.host!==socket.id) return;
    dotsNextQuestion(code);
  });

  socket.on('dots:answer',({code,answerIndex,timeLeft})=>{
    const room=dotsRooms[code];
    if(!room||room.state!=='question') return;
    const player=room.players[socket.id];
    if(!player||player.answers[room.currentQ]!==undefined) return;
    const q=room.questions[room.currentQ];
    let realIndex=answerIndex;
    if(player.shuffleMap&&player.shuffleMap[room.currentQ]) realIndex=player.shuffleMap[room.currentQ][answerIndex];
    const correct=realIndex===q.correct;
    const points=correct?Math.round(500+(Math.max(0,timeLeft)/q.time)*500):0;
    player.score+=points;
    const answerTime=Date.now();
    player.answers[room.currentQ]={answerIndex:realIndex,correct,points,answerTime};
    // anti-cheat
    if(!room.answerTimes[room.currentQ]) room.answerTimes[room.currentQ]=[];
    const now=Date.now();
    room.answerTimes[room.currentQ].push({name:player.name,time:now,correct});
    const suspicious=room.answerTimes[room.currentQ].filter(a=>Math.abs(a.time-now)<1000);
    if(suspicious.length>=3) io.to(room.host).emit('dots:suspicious',{message:`⚠️ ${suspicious.length} لاعبين أجابوا في نفس الوقت!`});
    const count=Object.values(room.players).filter(p=>p.answers[room.currentQ]!==undefined).length;
    const barData=q.answers.map((_,i)=>Object.values(room.players).filter(p=>p.answers[room.currentQ]?.answerIndex===i).length);
    io.to(room.host).emit('dots:answeredCount',{count,total:Object.keys(room.players).length,barData});
  });

  socket.on('dots:showResults',({code})=>{
    const room=dotsRooms[code];
    if(!room||room.host!==socket.id) return;
    dotsShowResults(code);
  });

  socket.on('dots:skip',({code})=>{
    const room=dotsRooms[code];
    if(!room||room.host!==socket.id) return;
    dotsNextQuestion(code);
  });

  socket.on('dots:next',({code})=>{
    const room=dotsRooms[code];
    if(!room||room.host!==socket.id) return;
    if(isGameComplete(room)) dotsEndGame(code);
    else dotsNextQuestion(code);
  });

  socket.on('dots:drawLine',({code,lineKey})=>{
    const room=dotsRooms[code];
    if(!room) return;
    const player=room.players[socket.id];
    if(!player) return;
    if(room.lines[lineKey]) return; // already drawn
    // فقط اللاعب الفائز يقدر يرسم
    if(socket.id !== room.pendingWinPlayerSid && player.team!==room.pendingWinTeam) return;
    room.currentTurn=player.team;
    room.lines[lineKey]=player.team;
    const newBoxes=checkBoxes(room,lineKey);
    const scores=calcScores(room);
    io.to('dots_'+code).emit('dots:lineDrawn',{lineKey,team:player.team,newBoxes,scores});
    io.to(room.host).emit('dots:lineDrawn',{lineKey,team:player.team,newBoxes,scores});
    room.pendingWinTeam=null;
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
