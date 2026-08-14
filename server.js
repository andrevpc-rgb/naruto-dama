// Damas Ninja — servidor de "Batalha Privada" + Contas + Ranking + Matchmaking
//
// O RELAY de jogo (salas privadas por código) continua funcionando exatamente como antes: o servidor
// NÃO conhece as regras do jogo (capturas, habilidades, etc.), só repassa mensagens de um jogador para
// o outro dentro da mesma sala. Essa parte não foi tocada.
//
// O que foi ADICIONADO nesta versão:
//   1. Contas de jogador (cadastro/login) com senha criptografada (bcrypt) e sessão via JWT.
//   2. Ranking da temporada (pontos por vitória/derrota) com reset automático todo dia 1º e um
//      "Hall da Fama" guardando os campeões de cada mês.
//   3. Matchmaking: fila de "Buscar Partida Online" que pareia dois jogadores reais em até 15s, ou cai
//      automaticamente para uma partida contra bot se ninguém mais entrar na fila a tempo.
//
// IMPORTANTE sobre o bot do matchmaking: ele NÃO roda aqui no servidor. O jogo inteiro (regras, damas,
// habilidades) só existe no arquivo .html, rodando no navegador — reescrever tudo isso em Node.js seria
// duplicar ~5000 linhas de lógica só para o bot jogar sozinho. Em vez disso, quando cai no bot, o CLIENTE
// simplesmente ativa localmente o mesmo motor de IA do modo "Jogar com Robô" (já existente e testado),
// disfarçado com um nick aleatório e um pequeno atraso antes de cada lance pra parecer mais humano. O
// servidor só entra pra: (a) avisar o cliente "caiu no bot, aqui está o nick dele" e (b) receber o
// resultado final pra atualizar o ranking. Ver o bloco "MATCHMAKING" abaixo e o novo trecho no .html.
//
// Como rodar:
//   1. Copie .env.example para .env e preencha MONGODB_URI (MongoDB Atlas) e JWT_SECRET.
//   2. npm install
//   3. npm start
// O servidor sobe em http://localhost:3001 (ou na porta definida em PORT) e também serve o .html direto.
// Sem MONGODB_URI configurado, o servidor ainda sobe normalmente — só que login/cadastro/ranking ficam
// desativados (a Batalha Privada por código e o matchmaking PvP continuam funcionando sem banco).

require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

const PORT = process.env.PORT || 3001;
const MAX_ROOMS = 2000; // trava simples contra esgotamento de memória em uso indevido
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN = '30d'; // sessão fica válida por 30 dias no localStorage
const MONGODB_URI = process.env.MONGODB_URI || '';

// --- Pontuação da temporada -------------------------------------------------------------------------
const POINTS_PER_WIN = 20;
const POINTS_LOST_PER_LOSS = 5; // subtraído, mas nunca deixa seasonPoints ficar negativo

// --- Clãs -------------------------------------------------------------------------------------------
const CLANS = [
  'Uzumaki', 'Uchiha', 'Hyūga', 'Nara', 'Senju', 'Akimichi', 'Yamanaka', 'Aburame',
  'Inuzuka', 'Kazekage', 'Sarutobi', 'Sabaku', 'Kaguya'
];

// --- Patentes por pontuação (Rank Ninja) -------------------------------------------------------------
// Os mesmos limiares são usados tanto pra decorar o ranking/HUD quanto (indiretamente, via winrate — que
// é outra coisa) pra nada relacionado à dificuldade do bot. Um único lugar pra mudar os números depois.
const RANK_TIERS = [
  { max: 200, name: 'Gennin' },
  { max: 500, name: 'Chuunin' },
  { max: 1000, name: 'Jounin' },
  { max: 2000, name: 'Sennin' },
  { max: Infinity, name: 'Kage' }
];

function rankClassFor(points) {
  const p = Math.max(0, points || 0);
  return RANK_TIERS.find(t => p <= t.max).name;
}

// Fácil até 30% de winrate, médio até 70%, difícil acima disso. Jogador sem partidas ainda (0/0) cai no
// médio — não tem histórico pra justificar nem facilitar nem dificultar.
function botDifficultyForWinrate(wins, losses) {
  const total = (wins || 0) + (losses || 0);
  if (total === 0) return 'medium';
  const winrate = wins / total;
  if (winrate <= 0.30) return 'easy';
  if (winrate <= 0.70) return 'medium';
  return 'hard';
}

// --- Matchmaking -------------------------------------------------------------------------------------
const MATCH_WAIT_MS = 15000; // tempo procurando jogador real antes de cair pro bot
const BOT_NICKNAMES = [
  'MestreDamas99', 'Kage_Obito', 'Ninja_Kazekage', 'SombraAnbu', 'ChakraInfinito',
  'RaposaDeNove', 'GenjutsuMaster', 'TaijutsuPro', 'AkatsukiFan22', 'DamasHokage',
  'SharinganX', 'VilaOculta_7', 'JutsuRelampago', 'FolhaVerde_Nin', 'AreiaVermelha',
  'ByakuganPro', 'RyuNinja', 'KunaiCerteiro', 'ClonesDeSombra', 'SelosSecretos'
];

function randomBotNickname() {
  return BOT_NICKNAMES[Math.floor(Math.random() * BOT_NICKNAMES.length)] + '#' + Math.floor(100 + Math.random() * 900);
}

const app = express();
app.use(cors({ origin: '*' })); // GitHub Pages e o Render são origens diferentes — precisa liberar
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // sala privada por código — não expõe dados entre salas, então CORS aberto é ok aqui
});

// =======================================================================================================
// BANCO DE DADOS (MongoDB Atlas via Mongoose)
// =======================================================================================================

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('[db] Conectado ao MongoDB.'))
    .catch((err) => console.error('[db] Falha ao conectar no MongoDB — login/cadastro/ranking ficam desativados até isso ser corrigido:', err.message));
} else {
  console.warn('[db] MONGODB_URI não configurado (.env) — login/cadastro/ranking ficam desativados. A Batalha Privada por código e o matchmaking PvP continuam funcionando normalmente.');
}

function dbReady() {
  return mongoose.connection.readyState === 1; // 1 = connected
}

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  clan: { type: String, required: true, enum: CLANS },
  seasonPoints: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Um documento por (mês, jogador) que terminou entre os melhores daquele mês — arquivado pelo cron de
// reset da temporada (ver "RESET MENSAL" mais abaixo).
const seasonChampionSchema = new mongoose.Schema({
  month: { type: String, required: true }, // "AAAA-MM" do mês que terminou, ex: "2026-08"
  username: { type: String, required: true },
  points: { type: Number, required: true },
  position: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});
const SeasonChampion = mongoose.model('SeasonChampion', seasonChampionSchema);

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    clan: user.clan,
    seasonPoints: user.seasonPoints,
    rankClass: rankClassFor(user.seasonPoints),
    wins: user.wins,
    losses: user.losses,
    createdAt: user.createdAt
  };
}

// =======================================================================================================
// AUTENTICAÇÃO (JWT + bcrypt)
// =======================================================================================================

function signToken(user) {
  return jwt.sign({ sub: String(user._id), nick: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  if (!token || !JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null; // expirado ou inválido — trata como "não autenticado", não derruba o processo
  }
}

function requireDb(req, res, next) {
  if (!dbReady()) return res.status(503).json({ error: 'Banco de dados indisponível no momento. Tente de novo em instantes.' });
  next();
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login de novo.' });
  req.userId = payload.sub;
  next();
}

app.get('/api/clans', (req, res) => {
  res.json({ clans: CLANS });
});

app.post('/api/auth/register', requireDb, async (req, res) => {
  const { username, email, password, clan } = req.body || {};
  const usernameNorm = String(username || '').trim();
  const emailNorm = String(email || '').trim().toLowerCase();

  if (!usernameNorm || !emailNorm || !password || !clan) {
    return res.status(400).json({ error: 'Preencha nome de usuário, e-mail, senha e clã.' });
  }
  if (usernameNorm.length < 3 || usernameNorm.length > 20) {
    return res.status(400).json({ error: 'Nome de usuário deve ter entre 3 e 20 caracteres.' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(usernameNorm)) {
    return res.status(400).json({ error: 'Nome de usuário só pode ter letras, números e "_".' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  if (!CLANS.includes(clan)) {
    return res.status(400).json({ error: 'Escolha um clã válido.' });
  }

  try {
    const exists = await User.findOne({ $or: [{ username: usernameNorm }, { email: emailNorm }] });
    if (exists) {
      const field = exists.username === usernameNorm ? 'Esse nome de usuário' : 'Esse e-mail';
      return res.status(409).json({ error: `${field} já está em uso.` });
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.create({ username: usernameNorm, email: emailNorm, passwordHash, clan });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('[auth] erro no /register:', err.message);
    res.status(500).json({ error: 'Erro ao criar conta. Tente de novo.' });
  }
});

app.post('/api/auth/login', requireDb, async (req, res) => {
  const { identifier, password } = req.body || {}; // identifier = nome de usuário OU e-mail
  const idNorm = String(identifier || '').trim();
  if (!idNorm || !password) {
    return res.status(400).json({ error: 'Preencha usuário/e-mail e senha.' });
  }
  try {
    const user = await User.findOne({ $or: [{ username: idNorm }, { email: idNorm.toLowerCase() }] });
    if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('[auth] erro no /login:', err.message);
    res.status(500).json({ error: 'Erro ao entrar. Tente de novo.' });
  }
});

// Troca de senha "provisória": só exige o e-mail cadastrado + a nova senha, sem link de recuperação por
// e-mail (ainda não existe) nem confirmação da senha atual. É deliberadamente mais fraca que um fluxo de
// recuperação de verdade — qualquer pessoa que souber o e-mail de alguém consegue trocar a senha dela.
// Documentado como limitação temporária; o pedido original já previa endurecer isso depois.
app.post('/api/auth/change-password', requireDb, async (req, res) => {
  const { email, newPassword } = req.body || {};
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm || !newPassword) {
    return res.status(400).json({ error: 'Preencha o e-mail cadastrado e a nova senha.' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
  }
  try {
    const user = await User.findOne({ email: emailNorm });
    if (!user) return res.status(404).json({ error: 'Não existe conta com esse e-mail.' });
    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] erro no /change-password:', err.message);
    res.status(500).json({ error: 'Erro ao trocar a senha. Tente de novo.' });
  }
});

app.get('/api/auth/me', requireDb, requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar perfil.' });
  }
});

// =======================================================================================================
// RANKING DA TEMPORADA + HALL DA FAMA
// =======================================================================================================

app.get('/api/ranking', requireDb, async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  try {
    const users = await User.find().sort({ seasonPoints: -1, wins: -1 }).limit(limit)
      .select('username clan seasonPoints wins losses').lean();
    res.json({
      ranking: users.map((u, i) => ({
        position: i + 1, username: u.username, clan: u.clan, seasonPoints: u.seasonPoints,
        rankClass: rankClassFor(u.seasonPoints), wins: u.wins, losses: u.losses
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar o ranking.' });
  }
});

// Ranking por clã: MÉDIA de pontos entre os membros do clã (não soma) — assim um clã com poucos membros
// muito bons pode liderar sobre um clã grande e mediano, em vez do ranking só refletir "que clã tem mais
// gente jogando". totalPoints e memberCount também vêm na resposta caso o front prefira exibir a soma.
app.get('/api/ranking/clans', requireDb, async (req, res) => {
  try {
    const agg = await User.aggregate([
      { $group: {
        _id: '$clan',
        avgPoints: { $avg: '$seasonPoints' },
        totalPoints: { $sum: '$seasonPoints' },
        memberCount: { $sum: 1 }
      } },
      { $sort: { avgPoints: -1 } }
    ]);
    res.json({
      clans: agg.map((c, i) => ({
        position: i + 1, clan: c._id, avgPoints: Math.round(c.avgPoints),
        totalPoints: c.totalPoints, memberCount: c.memberCount
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar o ranking por clã.' });
  }
});

app.get('/api/hall-of-fame', requireDb, async (req, res) => {
  try {
    const champions = await SeasonChampion.find().sort({ month: -1, position: 1 }).limit(150).lean();
    res.json({ champions });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar o Hall da Fama.' });
  }
});

// Arquiva o Top 50 da temporada que terminou em SeasonChampion e zera seasonPoints de todo mundo.
// Chamada automaticamente pelo cron (meia-noite do dia 1º) — ver agendamento no fim do arquivo.
async function resetSeason() {
  if (!dbReady()) {
    console.warn('[ranking] Reset de temporada pulado — banco de dados indisponível.');
    return;
  }
  try {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthLabel = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

    const top = await User.find({ seasonPoints: { $gt: 0 } }).sort({ seasonPoints: -1 }).limit(50).lean();
    if (top.length) {
      await SeasonChampion.insertMany(top.map((u, i) => ({
        month: monthLabel, username: u.username, points: u.seasonPoints, position: i + 1
      })));
    }
    await User.updateMany({}, { $set: { seasonPoints: 0 } });
    console.log(`[ranking] Temporada ${monthLabel} arquivada (${top.length} jogador(es) no Hall da Fama) e pontos zerados.`);
  } catch (err) {
    console.error('[ranking] Erro no reset da temporada:', err.message);
  }
}

// =======================================================================================================
// RELAY DE SALA PRIVADA (Batalha Privada por código) — comportamento original, inalterado
// =======================================================================================================

// code -> { hostSocketId, guestSocketId, createdAt, isMatchmaking }
const rooms = new Map();

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sem I/O pra não confundir com 1/0
const CODE_DIGITS = '0123456789';

function randomFrom(chars, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function generateRoomCode() {
  let code;
  let attempts = 0;
  do {
    code = `${randomFrom(CODE_LETTERS, 3)}-${randomFrom(CODE_DIGITS, 3)}`;
    attempts++;
  } while (rooms.has(code) && attempts < 50);
  return code;
}

function roomIsEmpty(room) {
  return !room.hostSocketId && !room.guestSocketId;
}

function leaveCurrentRoom(socket, { notifyOpponent } = { notifyOpponent: true }) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (room) {
    if (room.hostSocketId === socket.id) room.hostSocketId = null;
    if (room.guestSocketId === socket.id) room.guestSocketId = null;
    if (notifyOpponent) socket.to(code).emit('opponent_left');
    if (roomIsEmpty(room)) rooms.delete(code);
  }
  socket.leave(code);
  socket.data.roomCode = null;
  socket.data.role = null;
}

// =======================================================================================================
// MATCHMAKING (fila "Buscar Partida Online" + fallback pra bot)
// =======================================================================================================

// Fila de espera: cada item é { socket, timer }. Pareamento é sempre "o primeiro que chegou" (FIFO) —
// assim que um segundo jogador clica em "Buscar Partida", ele pega quem já estava esperando na hora, sem
// precisar esperar os 15s (o timer só serve pra decidir "ninguém apareceu, chama o bot").
let matchQueue = [];

function removeFromQueue(socketId) {
  const idx = matchQueue.findIndex(e => e.socket.id === socketId);
  if (idx === -1) return null;
  const [entry] = matchQueue.splice(idx, 1);
  clearTimeout(entry.timer);
  return entry;
}

// Busca clã + patente de um jogador logado pra mandar no payload de match_found (pro cliente já montar o
// "[Nome] [Classe] do clã [Clã]" do adversário sem precisar de uma segunda ida ao servidor). Sem conta
// (userId nulo) ou sem banco, cai num perfil neutro em vez de quebrar o pareamento.
async function lookupPlayerProfile(userId) {
  if (!userId || !dbReady()) return { clan: null, rankClass: 'Gennin' };
  try {
    const user = await User.findById(userId).select('clan seasonPoints').lean();
    if (!user) return { clan: null, rankClass: 'Gennin' };
    return { clan: user.clan, rankClass: rankClassFor(user.seasonPoints) };
  } catch (err) {
    return { clan: null, rankClass: 'Gennin' };
  }
}

// Pareia 2 jogadores reais: reaproveita o MESMO mecanismo de salas do relay acima (rooms/game_action),
// só que criado automaticamente em vez de por código digitado — o resto do sync funciona idêntico.
async function startPvpMatch(entryA, entryB) {
  const code = generateRoomCode();
  rooms.set(code, {
    hostSocketId: entryA.socket.id,
    guestSocketId: entryB.socket.id,
    hostVillageTitle: '',
    createdAt: Date.now(),
    isMatchmaking: true
  });
  entryA.socket.join(code);
  entryB.socket.join(code);
  entryA.socket.data.roomCode = code;
  entryA.socket.data.role = 'host';
  entryB.socket.data.roomCode = code;
  entryB.socket.data.role = 'guest';

  const nickA = entryA.socket.data.nick || 'Jogador';
  const nickB = entryB.socket.data.nick || 'Jogador';
  const [profileA, profileB] = await Promise.all([
    lookupPlayerProfile(entryA.socket.data.userId),
    lookupPlayerProfile(entryB.socket.data.userId)
  ]);
  entryA.socket.emit('match_found', {
    isBot: false, role: 'host', code, opponentNick: nickB,
    opponentClan: profileB.clan, opponentRankClass: profileB.rankClass
  });
  entryB.socket.emit('match_found', {
    isBot: false, role: 'guest', code, opponentNick: nickA,
    opponentClan: profileA.clan, opponentRankClass: profileA.rankClass
  });
}

// Ninguém apareceu em 15s — avisa o cliente pra ativar o bot LOCALMENTE (ver comentário no topo do
// arquivo). O servidor não simula peça nenhuma aqui, só manda o apelido falso, um clã aleatório (só pra
// enfeitar o HUD) e a dificuldade calculada pela winrate do jogador logado.
async function startBotMatch(entry) {
  const botClan = CLANS[Math.floor(Math.random() * CLANS.length)];
  const botRankClass = RANK_TIERS[Math.floor(Math.random() * RANK_TIERS.length)].name;
  let difficulty = 'medium';
  if (entry.socket.data.userId && dbReady()) {
    try {
      const user = await User.findById(entry.socket.data.userId).select('wins losses').lean();
      if (user) difficulty = botDifficultyForWinrate(user.wins, user.losses);
    } catch (err) {
      // mantém 'medium' em qualquer erro
    }
  }
  entry.socket.emit('match_found', {
    isBot: true, opponentNick: randomBotNickname(), opponentClan: botClan,
    opponentRankClass: botRankClass, botDifficulty: difficulty
  });
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.role = null;
  socket.data.userId = null;
  socket.data.nick = null;

  // Token JWT opcional mandado na conexão (io(url, { auth: { token } })) — se for válido, guarda quem é
  // esse jogador pra poder salvar vitórias/derrotas dele no matchmaking depois. Sem token (ou inválido),
  // o socket funciona normalmente para Batalha Privada por código, só não pontua no ranking.
  const authToken = socket.handshake.auth && socket.handshake.auth.token;
  const authPayload = verifyToken(authToken);
  if (authPayload) {
    socket.data.userId = authPayload.sub;
    socket.data.nick = authPayload.nick;
  }

  // "villageTitle" is just an opaque label the host picked client-side (e.g. "Konoha", "Amegakure") —
  // the server never interprets it, only stores and hands it back to the guest so their client can show
  // the right "vs" screen and exclude that village from the guest's own choices.
  socket.on('create_room', (data, ack) => {
    if (typeof ack !== 'function') return;
    leaveCurrentRoom(socket);

    if (rooms.size >= MAX_ROOMS) {
      ack({ ok: false, error: 'Servidor cheio no momento. Tente de novo em instantes.' });
      return;
    }

    const villageTitle = String((data && data.villageTitle) || '').slice(0, 40);
    const code = generateRoomCode();
    rooms.set(code, { hostSocketId: socket.id, guestSocketId: null, hostVillageTitle: villageTitle, createdAt: Date.now() });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'host';

    ack({ ok: true, code, role: 'host' });
  });

  socket.on('join_room', (rawCode, ack) => {
    if (typeof ack !== 'function') return;
    const code = String(rawCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      ack({ ok: false, error: 'Sala não encontrada. Confira o código e tente de novo.' });
      return;
    }
    if (room.guestSocketId) {
      ack({ ok: false, error: 'Essa sala já está cheia.' });
      return;
    }
    if (room.hostSocketId === socket.id) {
      ack({ ok: false, error: 'Você já está nessa sala.' });
      return;
    }

    leaveCurrentRoom(socket);

    room.guestSocketId = socket.id;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'guest';

    ack({ ok: true, code, role: 'guest', hostVillageTitle: room.hostVillageTitle || '' });
    io.to(room.hostSocketId).emit('opponent_joined');
  });

  // Repassa qualquer ação de jogo (clique numa casa, clique no botão de habilidade, resultado da
  // colocação inicial, etc.) só para o adversário dentro da mesma sala. O servidor não valida o
  // conteúdo — cada cliente confia no outro dentro da sala privada, do mesmo jeito que confiaria
  // sentado ao lado no modo "Jogar com Amigo". O mesmo vale para partidas de matchmaking (isMatchmaking).
  socket.on('game_action', (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.to(code).emit('game_action', payload);
  });

  socket.on('leave_room', () => leaveCurrentRoom(socket));

  // --- Matchmaking events ---
  socket.on('find_match', () => {
    if (matchQueue.some(e => e.socket.id === socket.id)) return; // já está na fila
    if (socket.data.roomCode) return; // já está numa partida

    // Alguém já esperando? Pareia na hora, sem precisar dos 15s.
    const waiting = matchQueue.shift();
    if (waiting) {
      clearTimeout(waiting.timer);
      startPvpMatch(waiting, { socket });
      return;
    }

    const entry = { socket, timer: null };
    entry.timer = setTimeout(() => {
      removeFromQueue(socket.id);
      startBotMatch(entry);
    }, MATCH_WAIT_MS);
    matchQueue.push(entry);
  });

  socket.on('cancel_find_match', () => {
    removeFromQueue(socket.id);
  });

  // O cliente manda isso quando a partida (matchmaking PvP OU contra bot) termina, pra creditar pontos
  // no ranking do jogador logado. payload: { result: 'win' | 'loss' }. Sem token válido na conexão
  // (socket.data.userId nulo), isso é ignorado silenciosamente — sem conta, não pontua.
  socket.on('report_match_result', async (payload) => {
    if (!socket.data.userId || !dbReady()) return;
    const result = payload && payload.result;
    if (result !== 'win' && result !== 'loss') return;
    try {
      const user = await User.findById(socket.data.userId);
      if (!user) return;
      if (result === 'win') {
        user.wins += 1;
        user.seasonPoints += POINTS_PER_WIN;
      } else {
        user.losses += 1;
        user.seasonPoints = Math.max(0, user.seasonPoints - POINTS_LOST_PER_LOSS);
      }
      await user.save();
      socket.emit('match_result_saved', { seasonPoints: user.seasonPoints, wins: user.wins, losses: user.losses });
    } catch (err) {
      console.error('[matchmaking] erro ao salvar resultado:', err.message);
    }
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);
  });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, queue: matchQueue.length, db: dbReady() });
});

// Reset da temporada: meia-noite (horário do servidor) do dia 1º de todo mês.
cron.schedule('0 0 1 * *', resetSeason);

server.listen(PORT, () => {
  console.log(`Damas Ninja — servidor rodando em http://localhost:${PORT}`);
});
