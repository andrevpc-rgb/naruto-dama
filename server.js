// Damas Ninja — servidor de "Batalha Privada"
//
// Este servidor NÃO conhece as regras do jogo (capturas, habilidades, etc.). Ele só faz 3 coisas:
//   1. Cria salas com um código curto (ex: ABC-123) quando um jogador clica em "Criar Sala Privada".
//   2. Coloca um segundo jogador na mesma sala quando ele digita esse código.
//   3. Repassa (relay) qualquer mensagem de um jogador só para o outro jogador DAQUELA sala — nunca
//      para o resto do servidor. Cada cliente já roda a lógica completa do jogo localmente; o servidor
//      só sincroniza as duas telas repetindo a mesma sequência de cliques/ações nos dois lados.
//
// Como rodar:
//   npm install
//   npm start
// O servidor sobe em http://localhost:3001 (ou na porta definida em PORT) e também serve o
// naruto-damas.html direto — ou seja, dá pra abrir o jogo em http://localhost:3001 em vez do arquivo
// local, e a "Batalha Privada" já funciona. Abrir o .html direto (file://) continua funcionando
// normalmente para todos os OUTROS modos — só a Batalha Privada precisa deste servidor rodando.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const MAX_ROOMS = 2000; // trava simples contra esgotamento de memória em uso indevido

const app = express();
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // sala privada por código — não expõe dados entre salas, então CORS aberto é ok aqui
});

// code -> { hostSocketId, guestSocketId, createdAt }
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

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.role = null;

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
  // sentado ao lado no modo "Jogar com Amigo".
  socket.on('game_action', (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.to(code).emit('game_action', payload);
  });

  socket.on('leave_room', () => leaveCurrentRoom(socket));

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

server.listen(PORT, () => {
  console.log(`Damas Ninja — servidor de Batalha Privada rodando em http://localhost:${PORT}`);
});
