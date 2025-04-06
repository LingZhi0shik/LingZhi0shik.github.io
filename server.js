const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 检查public目录是否存在
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
  console.log('使用public目录作为静态文件目录');
} else {
  app.use(express.static(__dirname));
  console.log('使用当前目录作为静态文件目录');
}

// 明确添加根路径处理
app.get('/', (req, res) => {
  const indexInPublic = path.join(__dirname, 'public', 'index.html');
  
  if (fs.existsSync(indexInPublic)) {
    res.sendFile(indexInPublic);
  } else {
    const indexInRoot = path.join(__dirname, 'index.html');
    
    if (fs.existsSync(indexInRoot)) {
      res.sendFile(indexInRoot);
    } else {
      res.status(404).send('未找到游戏文件。请确保index.html文件存在。');
    }
  }
});

// 添加调试中间件
app.use((req, res, next) => {
  console.log(`收到请求: ${req.method} ${req.url}`);
  next();
});

// 贪吃蛇游戏配置
const gameConfig = {
  gridSize: 30,           // 网格大小
  baseSpeed: 150,         // 基础速度(毫秒)
  updateInterval: 100,    // 游戏状态更新间隔
  foodTypes: [
    'red', 'yellow', 'green', 'blue', 'purple'
  ],
  portalChance: 0.5,      // 传送门出现概率
  portalLifetime: 20000   // 传送门持续时间(毫秒)
};

// 游戏房间管理
const games = {};
const gameIntervals = {}; // 存储游戏循环intervals的引用

// 当客户端连接
io.on('connection', (socket) => {
  console.log('用户已连接:', socket.id);
  
// 创建新游戏房间
socket.on('createGame', (playerData) => {
    const gameId = generateGameId();
    const { playerName, playerColor } = playerData;
    
    // 如果玩家已经在某个游戏中，先处理离开
    if (socket.gameId && games[socket.gameId]) {
        handlePlayerLeave(socket);
    }
    
    // 创建游戏房间
    games[gameId] = {
        id: gameId,
        players: [{
            id: socket.id,
            name: playerName,
            color: playerColor || getRandomColor(),
            snake: generateInitialSnake(),
            score: 0,
            isHost: true,
            isAlive: true
        }],
        foods: [],
        obstacles: [],
        started: false,
        gameMode: 'classic',
        allowRespawn: true,
        allowLateJoin: false,
        lastUpdateTime: Date.now()
    };
    
    // 生成初始食物
    generateFood(games[gameId]);
    
    socket.join(gameId);
    socket.gameId = gameId;
    socket.emit('gameCreated', gameId);
    socket.emit('playerJoined', games[gameId].players);
    socket.emit('updateGame', games[gameId]);

    console.log(`玩家 ${playerName} (${socket.id}) 创建了游戏 ${gameId}`);
});

  
  // 加入现有游戏
  socket.on('joinGame', (data) => {
    const { gameId, playerName, playerColor } = data;
    
    console.log(`尝试加入游戏: ${gameId}, 玩家: ${playerName} (${socket.id})`);
    
    if (!games[gameId]) {
      console.log(`游戏 ${gameId} 不存在`);
      socket.emit('error', '找不到游戏');
      return;
    }
    
    if (games[gameId].started && !games[gameId].allowLateJoin) {
      console.log(`游戏 ${gameId} 已经开始且不允许中途加入`);
      socket.emit('error', '游戏已经开始');
      return;
    }
    
    // 避免重复加入
    if (games[gameId].players.some(p => p.id === socket.id)) {
      console.log(`玩家 ${socket.id} 已在游戏中`);
      return;
    }
    
    // 添加新玩家
    games[gameId].players.push({
      id: socket.id,
      name: playerName,
      color: playerColor || getRandomColor(),
      snake: generateInitialSnake(games[gameId].players.length),
      score: 0,
      isHost: false,
      isAlive: true
    });
    
    socket.join(gameId);
    socket.gameId = gameId;
    socket.emit('gameJoined', gameId);
    
    // 向所有玩家广播玩家加入事件
    io.to(gameId).emit('playerJoined', games[gameId].players);
    io.to(gameId).emit('updateGame', games[gameId]);
    
    console.log(`玩家 ${playerName} (${socket.id}) 成功加入游戏 ${gameId}, 当前玩家数: ${games[gameId].players.length}`);
  });
  
// 开始游戏
socket.on('startGame', (options = {}) => {
    const gameId = socket.gameId;
    if (!games[gameId]) return;
    
    const game = games[gameId];
    const player = game.players.find(p => p.id === socket.id);
    
    // 只有房主可以开始游戏
    if (!player || !player.isHost) {
        socket.emit('error', '只有房主可以开始游戏');
        return;
    }
    
    // 设置游戏模式
    console.log('收到游戏模式设置:', options.gameMode);
    if (options.gameMode) {
        game.gameMode = options.gameMode;
    }
    
    // 设置是否允许中途加入
    game.allowLateJoin = options.allowLateJoin || false;
    
    // 根据游戏模式设置是否允许重生
    if (game.gameMode === 'classic') {
        // 经典模式强制允许重生，因为使用生命系统
        game.allowRespawn = true;
    } else {
        // 其他模式根据设置决定
        game.allowRespawn = options.allowRespawn !== undefined ? options.allowRespawn : true;
    }
    
    // 应用游戏设置
    if (options.gameSettings) {
        // 设置网格大小
        if (options.gameSettings.gridSize) {
            const oldGridSize = gameConfig.gridSize;
            gameConfig.gridSize = options.gameSettings.gridSize;
            
            console.log(`游戏${gameId}网格大小从${oldGridSize}更改为${gameConfig.gridSize}`);
            
            // 通知所有客户端新的网格大小
            io.to(gameId).emit('gridSizeChanged', {
                gridSize: gameConfig.gridSize,
                oldGridSize: oldGridSize,
                message: `网格大小已更改为 ${gameConfig.gridSize}x${gameConfig.gridSize}`
            });
        }
        
        // 设置游戏速度
        if (options.gameSettings.gameSpeed) {
            switch(options.gameSettings.gameSpeed) {
                case 'slow':
                    gameConfig.baseSpeed = 200;
                    gameConfig.updateInterval = 150;
                    break;
                case 'normal':
                    gameConfig.baseSpeed = 150;
                    gameConfig.updateInterval = 100;
                    break;
                case 'fast':
                    gameConfig.baseSpeed = 100;
                    gameConfig.updateInterval = 70;
                    break;
                case 'extreme':
                    gameConfig.baseSpeed = 70;
                    gameConfig.updateInterval = 50;
                    break;
            }
        }
        
        // 设置食物数量
        if (options.gameSettings.foodCount) {
            game.maxFoods = options.gameSettings.foodCount;
        }
        
        // 设置障碍物密度
        if (options.gameSettings.obstacleDensity) {
            switch(options.gameSettings.obstacleDensity) {
                case 'none':
                    game.obstacleDensity = 0;
                    break;
                case 'low':
                    game.obstacleDensity = 0.05;
                    break;
                case 'medium':
                    game.obstacleDensity = 0.1;
                    break;
                case 'high':
                    game.obstacleDensity = 0.2;
                    break;
            }
        }
        
        // 设置能力道具出现频率
        if (options.gameSettings.powerUps) {
            switch(options.gameSettings.powerUps) {
                case 'none':
                    game.powerUpRate = 0;
                    break;
                case 'rare':
                    game.powerUpRate = 0.1;
                    break;
                case 'normal':
                    game.powerUpRate = 0.2;
                    break;
                case 'frequent':
                    game.powerUpRate = 0.4;
                    break;
            }
        }
        
        console.log(`游戏${gameId}应用自定义设置:`, options.gameSettings);
    }
    
    console.log(`游戏${gameId}设置更新 - 模式:${game.gameMode}, 允许重生:${game.allowRespawn}`);
    
    // 初始化游戏
    game.started = true;
    game.lastUpdateTime = Date.now();
    
    // 为每个玩家在经典模式下添加生命值
    if (game.gameMode === 'classic') {
        game.players.forEach(p => {
            // 重新创建蛇以包含生命值
            p.snake = generateInitialSnake(game.players.indexOf(p), 'classic');
        });
    }
    
    // 根据游戏模式和障碍物密度生成障碍物
    if ((game.gameMode === 'challenge' || game.gameMode === 'classic') && game.obstacleDensity > 0) {
        generateObstacles(game);
    }
    
    // 开始游戏循环
    startGameLoop(gameId);
    
    // 将完整的游戏设置发送给所有客户端
    const gameSettings = {
        gridSize: gameConfig.gridSize,
        gameSpeed: gameConfig.baseSpeed,
        updateInterval: gameConfig.updateInterval,
        maxFoods: game.maxFoods || 5,
        obstacleDensity: game.obstacleDensity || 0.1,
        powerUpRate: game.powerUpRate || 0.2
    };
    
    io.to(gameId).emit('gameStarted', {
        gameMode: game.gameMode,
        allowRespawn: game.allowRespawn,
        allowLateJoin: game.allowLateJoin,
        gameSettings: gameSettings
    });
    
    console.log(`游戏 ${gameId} 已开始, 模式: ${game.gameMode}, 网格大小: ${gameConfig.gridSize}`);
});

  
  // 更改方向
  socket.on('changeDirection', (direction) => {
    const gameId = socket.gameId;
    if (!games[gameId] || !games[gameId].started) return;
    
    const game = games[gameId];
    const player = game.players.find(p => p.id === socket.id);
    
    if (!player || !player.isAlive) return;
    
    // 验证方向输入
    const validDirections = ['up', 'down', 'left', 'right'];
    if (!validDirections.includes(direction)) return;
    
    // 防止反方向移动
    const currentDirection = player.snake.direction || 'right';
    
    if ((currentDirection === 'up' && direction === 'down') ||
        (currentDirection === 'down' && direction === 'up') ||
        (currentDirection === 'left' && direction === 'right') ||
        (currentDirection === 'right' && direction === 'left')) {
      return;
    }
    
    // 更新方向
    player.snake.nextDirection = direction;
  });
  
  // 使用能力道具
  socket.on('usePowerUp', (type) => {
    const gameId = socket.gameId;
    if (!games[gameId] || !games[gameId].started) return;
    
    const game = games[gameId];
    const player = game.players.find(p => p.id === socket.id);
    
    if (!player || !player.isAlive || !player.powerUp) return;
    
    // 激活能力
    player.powerUpActive = true;
    player.powerUpType = type;
    player.powerUpTimeLeft = 5000; // 5秒持续时间
    
    io.to(gameId).emit('powerUpActivated', {
      playerId: player.id,
      playerName: player.name,
      powerUpType: type
    });
  });
  
  // 重置玩家(游戏中重生)
socket.on('respawn', (data = {}) => {
    const gameId = socket.gameId;
    if (!games[gameId] || !games[gameId].started) {
      console.log(`重生失败: 游戏${gameId}不存在或未开始`);
      return;
    }
    
    const game = games[gameId];
    const player = game.players.find(p => p.id === socket.id);
    
    if (!player) {
      console.log(`重生失败: 找不到玩家${socket.id}`);
      return;
    }
    
    console.log(`玩家${player.name}请求重生, 游戏模式:${game.gameMode}, 允许重生:${game.allowRespawn}`);
    
    // 只有在允许重生或者是禅模式下才能重生
    if (game.gameMode !== 'zen' && !game.allowRespawn) {
      console.log(`重生被拒绝: 游戏模式${game.gameMode}不允许重生且allowRespawn为${game.allowRespawn}`);
      socket.emit('error', '当前游戏模式不允许重生');
      return;
    }
    
    // 重置玩家状态
    player.isAlive = true;
    player.snake = generateInitialSnake(game.players.indexOf(player));
    player.score = Math.floor(player.score / 2); // 重生损失一半分数
    
    console.log(`玩家${player.name}已重生`);
    
    io.to(gameId).emit('playerRespawned', {
      playerId: player.id,
      playerName: player.name,
      score: player.score
    });
    
    io.to(gameId).emit('updateGame', game);
});

  
  // 更改游戏设置(仅房主)
  socket.on('updateSettings', (settings) => {
    const gameId = socket.gameId;
    if (!games[gameId]) return;
    
    const game = games[gameId];
    const player = game.players.find(p => p.id === socket.id);
    
    if (!player || !player.isHost) {
      socket.emit('error', '只有房主可以更改设置');
      return;
    }
    
    // 不能在游戏开始后更改设置
    if (game.started) {
      socket.emit('error', '游戏已开始，无法更改设置');
      return;
    }
    
    // 更新设置
    if (settings.gameMode) game.gameMode = settings.gameMode;
    if (settings.allowLateJoin !== undefined) game.allowLateJoin = settings.allowLateJoin;
    if (settings.allowRespawn !== undefined) game.allowRespawn = settings.allowRespawn;
    
    io.to(gameId).emit('settingsUpdated', {
      gameMode: game.gameMode,
      allowLateJoin: game.allowLateJoin,
      allowRespawn: game.allowRespawn
    });
  });
  
  // 发送聊天消息
  socket.on('sendMessage', (message) => {
    const gameId = socket.gameId;
    if (!games[gameId]) return;
    
    const player = games[gameId].players.find(p => p.id === socket.id);
    if (!player) return;
    
    // 限制消息长度
    const safeMessage = message.substring(0, 100);
    
    io.to(gameId).emit('newMessage', {
      playerId: player.id,
      playerName: player.name,
      message: safeMessage,
      timestamp: Date.now()
    });
  });
  
  // 玩家离开游戏
  socket.on('leaveGame', () => {
    handlePlayerLeave(socket);
  });
  
  // 断开连接处理
  socket.on('disconnect', () => {
    console.log('用户断开连接:', socket.id);
    handlePlayerLeave(socket);
  });
  
});

// 生成传送门函数 - 添加到服务器代码
function generatePortals(game) {
  // 如果已有传送门且未过期，则不生成
  if (game.portals && game.portals.length === 2 && game.portalExpireTime > Date.now()) {
    return;
  }
  
  // 清除已有传送门
  game.portals = [];
  
  // 设置传送门过期时间
  game.portalExpireTime = Date.now() + gameConfig.portalLifetime;
  
  // 生成两个传送门位置
  for (let i = 0; i < 2; i++) {
    let x, y, validPosition = false;
    let attempts = 0;
    const maxAttempts = 50;
    
    while (!validPosition && attempts < maxAttempts) {
      x = Math.floor(Math.random() * gameConfig.gridSize);
      y = Math.floor(Math.random() * gameConfig.gridSize);
      validPosition = true;
      attempts++;
      
      // 检查是否与任何玩家的蛇重叠
      for (const player of game.players) {
        if (!player.isAlive) continue;
        
        for (const segment of player.snake.segments) {
          if (segment.x === x && segment.y === y) {
            validPosition = false;
            break;
          }
        }
        if (!validPosition) break;
      }
      
      // 检查是否与障碍物重叠
      if (validPosition) {
        for (const obstacle of game.obstacles) {
          if (obstacle.x === x && obstacle.y === y) {
            validPosition = false;
            break;
          }
        }
      }
      
      // 检查是否与食物重叠
      if (validPosition) {
        for (const food of game.foods) {
          if (food.x === x && food.y === y) {
            validPosition = false;
            break;
          }
        }
      }
      
      // 检查是否与其他传送门太近
      if (validPosition && game.portals.length > 0) {
        const firstPortal = game.portals[0];
        const distance = Math.abs(firstPortal.x - x) + Math.abs(firstPortal.y - y);
        if (distance < 5) { // 确保传送门之间有一定距离
          validPosition = false;
        }
      }
    }
    
    // 添加传送门，设置颜色和ID
    game.portals.push({
      x: x,
      y: y,
      id: i,
      color: i === 0 ? '#2196F3' : '#E91E63' // 蓝色和粉色
    });
  }
  
  // 通知所有玩家
  io.to(game.id).emit('portalsSpawned', {
    portals: game.portals,
    expireTime: game.portalExpireTime
  });
  
  console.log(`游戏${game.id}生成传送门对: (${game.portals[0].x},${game.portals[0].y}) 和 (${game.portals[1].x},${game.portals[1].y})`);
}


// 处理玩家离开
function handlePlayerLeave(socket) {
    if (!socket.gameId || !games[socket.gameId]) return;
    
    const gameId = socket.gameId;
    const game = games[gameId];
    
    // 找到并移除玩家
    const playerIndex = game.players.findIndex(p => p.id === socket.id);
    
    if (playerIndex !== -1) {
        const isHost = game.players[playerIndex].isHost;
        const playerName = game.players[playerIndex].name;
        game.players.splice(playerIndex, 1);
        
        console.log(`玩家 ${playerName} (${socket.id}) 离开游戏 ${gameId}`);
        
        if (game.players.length === 0) {
            console.log(`游戏 ${gameId} 没有玩家了，删除游戏`);
            // 停止游戏循环
            if (gameIntervals[gameId]) {
                clearInterval(gameIntervals[gameId]);
                delete gameIntervals[gameId];
            }
            delete games[gameId];
        } else {
            // 如果主持人离开，让下一个玩家成为主持人
            if (isHost && game.players.length > 0) {
                game.players[0].isHost = true;
                console.log(`玩家 ${game.players[0].name} 成为新的主持人`);
            }
            
            // 通知其他玩家
            socket.leave(gameId);
            io.to(gameId).emit('playerLeft', {
                playerId: socket.id,
                playerName: playerName,
                players: game.players
            });
            
            // 发送完整游戏状态更新
            io.to(gameId).emit('updateGame', game);
        }
    }
    
    // 清除玩家的游戏ID
    socket.gameId = null;
}


// 游戏循环
function startGameLoop(gameId) {
  if (gameIntervals[gameId]) {
    clearInterval(gameIntervals[gameId]);
  }
  
  // 创建新的游戏循环
  gameIntervals[gameId] = setInterval(() => {
    const game = games[gameId];
    if (!game || !game.started) {
      clearInterval(gameIntervals[gameId]);
      delete gameIntervals[gameId];
      return;
    }
    
    // 更新游戏状态
    updateGameState(game);
    
    // 检查游戏是否结束
    checkGameEnd(game);
    
    // 向所有玩家发送更新
    io.to(gameId).emit('gameStateUpdate', {
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        snake: p.snake,
        score: p.score,
        isAlive: p.isAlive,
        powerUpActive: p.powerUpActive,
        powerUpType: p.powerUpType,
        scoreMultiplierActive: p.scoreMultiplierActive, // 添加分数翻倍状态
        color: p.color  // 确保颜色信息也被传递
      })),
      foods: game.foods,
      obstacles: game.obstacles,
      portals: game.portals,                    // 添加传送门信息
      portalExpireTime: game.portalExpireTime,  // 添加传送门过期时间
      gridSize: gameConfig.gridSize, // 添加网格大小信息
      gameMode: game.gameMode        // 添加游戏模式信息
    });
  }, gameConfig.updateInterval);
}


// 更新游戏状态
function updateGameState(game) {
  const now = Date.now();
  const deltaTime = now - game.lastUpdateTime;
  game.lastUpdateTime = now;
  
  // 验证网格大小
  if (!gameConfig.gridSize || gameConfig.gridSize <= 0) {
    console.error(`警告: 游戏${game.id}的网格大小无效: ${gameConfig.gridSize}, 重置为默认值30`);
    gameConfig.gridSize = 30;
  }
  
  // 更新每个玩家的蛇
  game.players.forEach(player => {
    // 处理自动复活倒计时
    if (player.isRespawning && player.respawnTime && player.respawnTime <= now) {
      console.log(`玩家${player.name}自动复活倒计时结束，即将复活`);
      
      // 复活玩家
      player.isRespawning = false;
      player.isAlive = true;
      
      // 保留当前的生命值
      const currentLives = player.snake.lives || 0;
      
      // 重新生成蛇，保持玩家索引
      player.snake = generateInitialSnake(game.players.indexOf(player), game.gameMode);
      
      // 恢复生命值
      if (game.gameMode === 'classic') {
        player.snake.lives = currentLives;
      }
      
      // 通知所有玩家
      io.to(game.id).emit('playerRespawned', {
        playerId: player.id,
        playerName: player.name,
        score: player.score,
        livesLeft: player.snake.lives,
        gameMode: game.gameMode
      });
      
      return; // 复活完成后本轮不处理移动
    }
    
    // 如果玩家已经死亡且不在复活状态中，跳过处理
    if (!player.isAlive && !player.isRespawning) return;
    
    // 对于活着的玩家，正常进行更新
    if (player.isAlive) {
      // 更新方向
      if (player.snake.nextDirection) {
        player.snake.direction = player.snake.nextDirection;
      }
      
      // 移动蛇
      moveSnake(player, game);
      
      // 检查碰撞
      checkCollisions(player, game);
      
      // 更新能力道具持续时间
      if (player.powerUpActive && player.powerUpTimeLeft > 0) {
        player.powerUpTimeLeft -= deltaTime;
        if (player.powerUpTimeLeft <= 0) {
          player.powerUpActive = false;
          player.powerUpType = null;
        }
      }
      
      // 更新分数翻倍持续时间 - 修正移动到这里
      if (player.scoreMultiplierActive && player.scoreMultiplierTimeLeft > 0) {
        player.scoreMultiplierTimeLeft -= deltaTime;
        if (player.scoreMultiplierTimeLeft <= 0) {
          player.scoreMultiplierActive = false;
          
          // 通知玩家分数翻倍结束
          io.to(game.id).emit('scoreMultiplierDeactivated', {
            playerId: player.id,
            playerName: player.name
          });
        }
      }
    }
  });
  
  // 检查是否需要生成新食物
  if (game.foods.length < (game.maxFoods || Math.min(5, game.players.length + 2))) {
    generateFood(game);
  }
  // 检查是否需要生成传送门 - 新增传送门逻辑
  if ((!game.portals || game.portals.length < 2 || game.portalExpireTime <= Date.now()) && 
      Math.random() < gameConfig.portalChance/100) {
    generatePortals(game);
  }
  
  // 检查传送门过期
  if (game.portals && game.portals.length > 0 && game.portalExpireTime <= Date.now()) {
    // 传送门过期，清除并通知客户端
    game.portals = [];
    io.to(game.id).emit('portalsExpired');
  }
}

// 根据食物类型获取分数
function getFoodPoints(foodType) {
  switch (foodType) {
    case 'red':
      return 15;  // 加速食物
    case 'yellow':
      return 10;  // 分数翻倍食物
    case 'green':
      return 10;  // 减速食物
    case 'blue':
      return 30;  // 穿墙食物
    case 'purple':
      return 40;  // 无敌食物
    default:
      return 10;  // 默认分数
  }
}

// 修改moveSnake函数 - 完整替换
function moveSnake(player, game) {
  if (!player.snake || !player.snake.segments || player.snake.segments.length === 0) return;
  
  // 获取头部位置
  const head = { ...player.snake.segments[0] };
  
  // 根据方向移动
  switch (player.snake.direction) {
    case 'up': head.y--; break;
    case 'down': head.y++; break;
    case 'left': head.x--; break;
    case 'right': head.x++; break;
  }
  
  // 检查边界碰撞，处理穿墙
  if (player.powerUpActive && player.powerUpType === 'phase') {
    // 穿墙能力
    if (head.x < 0) head.x = gameConfig.gridSize - 1;
    if (head.x >= gameConfig.gridSize) head.x = 0;
    if (head.y < 0) head.y = gameConfig.gridSize - 1;
    if (head.y >= gameConfig.gridSize) head.y = 0;
  } else {
    // 检查是否出界导致死亡
    if (head.x < 0 || head.x >= gameConfig.gridSize || head.y < 0 || head.y >= gameConfig.gridSize) {
      handlePlayerDeath(player, game, 'boundary');
      return;
    }
  }
  
  // 将新头部添加到蛇身
  player.snake.segments.unshift(head);
  
  // 检查是否进入传送门 - 新增传送门逻辑
  let teleported = false;
  if (game.portals && game.portals.length === 2 && game.portalExpireTime > Date.now()) {
    // 检查碰到哪个传送门
    const portalIndex = game.portals.findIndex(portal => portal.x === head.x && portal.y === head.y);
    
    if (portalIndex !== -1 && !player.recentlyTeleported) {
      // 设置冷却期，防止连续传送
      player.recentlyTeleported = true;
      
      // 传送到另一个传送门
      const otherPortal = game.portals[portalIndex === 0 ? 1 : 0];
      head.x = otherPortal.x;
      head.y = otherPortal.y;
      
      // 更新蛇头位置
      player.snake.segments[0] = head;
      
      // 通知所有玩家传送事件
      io.to(game.id).emit('playerTeleported', {
        playerId: player.id,
        playerName: player.name,
        fromPortal: portalIndex,
        toPortal: portalIndex === 0 ? 1 : 0
      });
      
      teleported = true;
      
      // 3秒后清除传送冷却
      setTimeout(() => {
        player.recentlyTeleported = false;
      }, 3000);
    }
  }
  
  // 检查是否吃到食物
  const foodIndex = game.foods.findIndex(food => food.x === head.x && food.y === head.y);
  
  if (foodIndex >= 0) {
    // 吃到食物
    const food = game.foods[foodIndex];
    game.foods.splice(foodIndex, 1);
    
    // 增加分数 - 考虑分数翻倍效果
    let points = getFoodPoints(food.type);
    
    // 如果玩家有分数翻倍状态，并且不是黄色食物自身，则分数翻倍
    if (player.scoreMultiplierActive && food.type !== 'yellow') {
      points *= 2;
      
      // 通知客户端这次得分是翻倍的
      io.to(game.id).emit('doublePoints', {
        playerId: player.id,
        playerName: player.name,
        points: points,
        position: { x: food.x, y: food.y }
      });
    }
    
    player.score += points;
    
    // 应用食物效果
    applyFoodEffect(player, food.type, game);
    
    // 通知所有玩家
    io.to(game.id).emit('foodEaten', {
      playerId: player.id,
      playerName: player.name,
      foodType: food.type,
      points: points,
      newScore: player.score,
      position: { x: food.x, y: food.y },
      doubleScore: player.scoreMultiplierActive && food.type !== 'yellow'
    });
    
    // 在禅模式和挑战模式下，可能需要生成新的障碍物
    if (game.gameMode === 'challenge' && Math.random() < 0.3) {
      generateObstacle(game);
    }
  } else if (!teleported) {
    // 没吃到食物且没传送，移除尾部
    player.snake.segments.pop();
  }
}



// 检查碰撞
function checkCollisions(player, game) {
  if (!player.isAlive || !player.snake || player.snake.segments.length === 0) return;
  
  const head = player.snake.segments[0];
  
  // 如果玩家处于无敌状态，跳过碰撞检测
  if (player.powerUpActive && player.powerUpType === 'invincible') {
    return;
  }
  
  // 检查自身碰撞
  for (let i = 1; i < player.snake.segments.length; i++) {
    if (player.snake.segments[i].x === head.x && player.snake.segments[i].y === head.y) {
      handlePlayerDeath(player, game, 'self');
      return;
    }
  }
  
  // 检查与障碍物碰撞
  for (const obstacle of game.obstacles) {
    if (obstacle.x === head.x && obstacle.y === head.y) {
      handlePlayerDeath(player, game, 'obstacle');
      return;
    }
  }
  
  // 检查与其他玩家碰撞
  for (const otherPlayer of game.players) {
    if (otherPlayer.id === player.id || !otherPlayer.isAlive) continue;
    
    for (const segment of otherPlayer.snake.segments) {
      if (segment.x === head.x && segment.y === head.y) {
        handlePlayerDeath(player, game, 'player', otherPlayer);
        return;
      }
    }
  }
}

// 处理玩家死亡
// 在server.js中修改handlePlayerDeath函数
function handlePlayerDeath(player, game, reason, killer = null) {
  // 如果是经典模式，使用生命系统
  if (game.gameMode === 'classic') {
    // 减少一条命
    player.snake.lives = (player.snake.lives || 0) - 1;
    
    // 如果还有生命，设置自动复活倒计时
    if (player.snake.lives > 0) {
      player.isAlive = false; // 设置为死亡，但会在倒计时结束后复活
      player.isRespawning = true; // 标记为正在复活中
      player.respawnTime = Date.now() + 3000; // 3秒后复活
      
      console.log(`玩家 ${player.name} 死亡，设置复活时间: ${new Date(player.respawnTime).toISOString()}, 剩余生命: ${player.snake.lives}`);
      
      // 通知所有玩家
      io.to(game.id).emit('playerDied', {
        playerId: player.id,
        playerName: player.name,
        reason: reason,
        killerId: killer ? killer.id : null,
        killerName: killer ? killer.name : null,
        livesLeft: player.snake.lives,
        gameMode: game.gameMode
      });
      
      return; // 不做后续处理，等待自动复活
    }
  }
  // 夺冠模式直接标记为可重生，不自动重生
  else if (game.gameMode === 'challenge') {
    player.isAlive = false;
    player.isRespawning = false; // 不需要自动复活倒计时
    
    // 通知所有玩家
    io.to(game.id).emit('playerDied', {
      playerId: player.id,
      playerName: player.name,
      reason: reason,
      killerId: killer ? killer.id : null,
      killerName: killer ? killer.name : null,
      gameMode: game.gameMode,
      allowManualRespawn: true // 添加标记表示可以手动重生
    });
    
    return; // 结束函数，等待玩家手动重生
  }
  
  // 其他模式或没有命的经典模式玩家
  player.isAlive = false;
  player.isRespawning = false;
  player.respawnTime = null;
  
  // 如果是玩家碰撞导致的死亡，杀手获得奖励
  if (reason === 'player' && killer) {
    killer.score += Math.floor(player.score * 0.2); // 获得死者20%的分数
  }
  
  // 通知所有玩家
  io.to(game.id).emit('playerDied', {
    playerId: player.id,
    playerName: player.name,
    reason: reason,
    killerId: killer ? killer.id : null,
    killerName: killer ? killer.name : null,
    livesLeft: game.gameMode === 'classic' ? player.snake.lives : undefined,
    gameMode: game.gameMode
  });
}




// 检查游戏结束
function checkGameEnd(game) {
  // 挑战模式保持不变
  if (game.gameMode === 'challenge') {
    const targetScore = 500; // 可配置
    const winner = game.players.find(p => p.score >= targetScore);
    
    if (winner) {
      console.log(`游戏${game.id}结束，挑战模式胜利者: ${winner.name}`);
      
      // 游戏结束，有玩家获胜
      io.to(game.id).emit('gameEnd', {
        winner: {
          id: winner.id,
          name: winner.name,
          score: winner.score
        },
        gameMode: 'challenge'
      });
      
      // 停止游戏循环
      if (gameIntervals[game.id]) {
        clearInterval(gameIntervals[game.id]);
        delete gameIntervals[game.id];
      }
      
      // 重置游戏状态为未开始但保留游戏设置
      game.started = false;
      game.foods = [];
      game.obstacles = [];
      
      // 重置所有玩家状态但保留连接
      game.players.forEach(p => {
        p.score = 0;
        p.isAlive = true;
        p.isRespawning = false;
        p.snake = generateInitialSnake(game.players.indexOf(p), game.gameMode);
        p.powerUpActive = false;
        p.powerUpType = null;
      });
    }
  }
  // 经典模式使用三命规则
  else if (game.gameMode === 'classic') {
    // 找出所有有效玩家（还有命或者正在复活的）
    const alivePlayers = game.players.filter(p => {
      // 满足以下任一条件即为有效:
      // 1. 玩家活着
      // 2. 玩家正在复活过程中
      // 3. 玩家虽死亡但还有生命值
      return p.isAlive || p.isRespawning || (p.snake && p.snake.lives > 0);
    });
    
    // 如果只剩一个有效玩家，且游戏中有多名玩家，则游戏结束
    if (alivePlayers.length === 1 && game.players.length > 1) {
      const winner = alivePlayers[0];
      
      console.log(`游戏${game.id}结束，三条命模式胜利者: ${winner.name}`);
      
      io.to(game.id).emit('gameEnd', {
        winner: {
          id: winner.id,
          name: winner.name,
          score: winner.score
        },
        message: `${winner.name} 是最后的幸存者!`,
        gameMode: 'classic'
      });
      
      // 停止游戏循环
      if (gameIntervals[game.id]) {
        clearInterval(gameIntervals[game.id]);
        delete gameIntervals[game.id];
      }
      
      // 重置游戏状态为未开始但保留游戏设置
      game.started = false;
      game.foods = [];
      game.obstacles = [];
      
      // 重置所有玩家状态但保留连接
      game.players.forEach(p => {
        p.score = 0;
        p.isAlive = true;
        p.isRespawning = false;
        p.snake = generateInitialSnake(game.players.indexOf(p), game.gameMode);
        p.powerUpActive = false;
        p.powerUpType = null;
      });
    }
  }
  // 其他模式的逻辑留空或添加其他模式的结束条件
}



// 生成初始蛇
function generateInitialSnake(playerIndex = 0, gameMode = 'classic') {
  // 根据玩家索引分配不同的起始位置
  let startX, startY;
  
  switch (playerIndex % 4) {
    case 0: // 左上
      startX = Math.floor(gameConfig.gridSize * 0.25);
      startY = Math.floor(gameConfig.gridSize * 0.25);
      break;
    case 1: // 右上
      startX = Math.floor(gameConfig.gridSize * 0.75);
      startY = Math.floor(gameConfig.gridSize * 0.25);
      break;
    case 2: // 左下
      startX = Math.floor(gameConfig.gridSize * 0.25);
      startY = Math.floor(gameConfig.gridSize * 0.75);
      break;
    case 3: // 右下
      startX = Math.floor(gameConfig.gridSize * 0.75);
      startY = Math.floor(gameConfig.gridSize * 0.75);
      break;
  }
  
  // 初始方向，朝向中心
  let direction;
  if (startX < gameConfig.gridSize / 2) {
    direction = 'right';
  } else {
    direction = 'left';
  }
  
  // 创建蛇身体(初始3节)
  const segments = [];
  for (let i = 0; i < 3; i++) {
    let x = startX;
    let y = startY;
    
    if (direction === 'right') {
      x -= i;
    } else if (direction === 'left') {
      x += i;
    } else if (direction === 'up') {
      y += i;
    } else if (direction === 'down') {
      y -= i;
    }
    
    segments.push({ x, y });
  }
  
  const snake = {
    direction: direction,
    nextDirection: direction,
    segments: segments
  };
  
  // 只有经典模式才添加生命值
  if (gameMode === 'classic') {
    snake.lives = 3; // 初始化为3条命
    console.log(`为玩家创建带生命值的蛇: ${snake.lives}条生命`);
  }
  
  return snake;
}

// 生成食物
function generateFood(game) {
  const foodType = gameConfig.foodTypes[Math.floor(Math.random() * gameConfig.foodTypes.length)];
  
  console.log(`游戏${game.id}尝试生成${foodType}类型的食物, 当前网格大小: ${gameConfig.gridSize}`);
  
  // 尝试找一个不在蛇身体和障碍物上的位置
  let x, y, validPosition = false;
  let attempts = 0;
  const maxAttempts = 50;
  
  while (!validPosition && attempts < maxAttempts) {
    x = Math.floor(Math.random() * gameConfig.gridSize);
    y = Math.floor(Math.random() * gameConfig.gridSize);
    validPosition = true;
    attempts++;
    
    // 检查是否与任何玩家的蛇重叠
    for (const player of game.players) {
      if (!player.isAlive) continue;
      
      for (const segment of player.snake.segments) {
        if (segment.x === x && segment.y === y) {
          validPosition = false;
          break;
        }
      }
      if (!validPosition) break;
    }
    
    // 检查是否与障碍物重叠
    if (validPosition) {
      for (const obstacle of game.obstacles) {
        if (obstacle.x === x && obstacle.y === y) {
          validPosition = false;
          break;
        }
      }
    }
    
    // 检查是否与其他食物重叠
    if (validPosition) {
      for (const food of game.foods) {
        if (food.x === x && food.y === y) {
          validPosition = false;
          break;
        }
      }
    }
  }
  
  // 如果找不到有效位置，选择随机位置
  if (!validPosition) {
    x = Math.floor(Math.random() * gameConfig.gridSize);
    y = Math.floor(Math.random() * gameConfig.gridSize);
    console.log(`游戏${game.id}无法找到有效食物位置，使用随机位置(${x},${y})`);
  }
  
  game.foods.push({
    x: x,
    y: y,
    type: foodType
  });
  
  console.log(`游戏${game.id}生成食物在位置(${x},${y}), 类型: ${foodType}`);
  
  // 通知所有玩家
  io.to(game.id).emit('foodSpawned', {
    x: x,
    y: y,
    type: foodType
  });
}

// 生成障碍物
function generateObstacles(game) {
  // 根据游戏模式决定障碍物数量
  let obstacleCount = 0;
  
  if (game.gameMode === 'challenge') {
    obstacleCount = 8 + Math.floor(Math.random() * 5); // 8-12个
  } else if (game.gameMode === 'classic') {
    obstacleCount = 3 + Math.floor(Math.random() * 3); // 3-5个
  }
  
  // 生成障碍物
  for (let i = 0; i < obstacleCount; i++) {
    generateObstacle(game);
  }
}

// 生成单个障碍物
function generateObstacle(game) {
// 避免过多障碍物
const maxObstacles = game.gameMode === 'challenge' ? 20 : 10;
if (game.obstacles.length >= maxObstacles) return;

// 尝试找一个不在蛇身体和食物上的位置
let x, y, validPosition = false;
let attempts = 0;
const maxAttempts = 50;

while (!validPosition && attempts < maxAttempts) {
x = Math.floor(Math.random() * gameConfig.gridSize);
y = Math.floor(Math.random() * gameConfig.gridSize);
validPosition = true;
attempts++;

// 检查是否与任何玩家的蛇重叠
for (const player of game.players) {
  if (!player.isAlive) continue;
  
  for (const segment of player.snake.segments) {
    if (segment.x === x && segment.y === y) {
      validPosition = false;
      break;
    }
  }
  
  // 额外保护：检查蛇头前方的位置(避免突然出现在蛇头前)
  if (validPosition && player.snake.segments.length > 0) {
    const head = player.snake.segments[0];
    const safeDistance = 5;
    
    if (Math.abs(head.x - x) + Math.abs(head.y - y) < safeDistance) {
      validPosition = false;
    }
  }
  
  if (!validPosition) break;
}

// 检查是否与食物重叠
if (validPosition) {
  for (const food of game.foods) {
    if (food.x === x && food.y === y) {
      validPosition = false;
      break;
    }
  }
}

// 检查是否与其他障碍物重叠
if (validPosition) {
  for (const obstacle of game.obstacles) {
    if (obstacle.x === x && obstacle.y === y) {
      validPosition = false;
      break;
    }
  }
}
}

// 如果找不到有效位置，选择随机位置
if (!validPosition) {
// 尝试在边缘生成
const edge = Math.floor(Math.random() * 4);
switch (edge) {
case 0: // 上边缘
x = Math.floor(Math.random() * gameConfig.gridSize);
y = 0;
break;
case 1: // 右边缘
x = gameConfig.gridSize - 1;
y = Math.floor(Math.random() * gameConfig.gridSize);
break;
case 2: // 下边缘
x = Math.floor(Math.random() * gameConfig.gridSize);
y = gameConfig.gridSize - 1;
break;
case 3: // 左边缘
x = 0;
y = Math.floor(Math.random() * gameConfig.gridSize);
break;
}
}

game.obstacles.push({ x, y });

// 通知所有玩家
io.to(game.id).emit('obstacleSpawned', { x, y });
}

// 应用食物效果
function applyFoodEffect(player, foodType, game) {
  switch (foodType) {
    case 'red':
      // 加速食物
      player.snake.speed = Math.max(50, (player.snake.speed || gameConfig.baseSpeed) - 20);
      break;
    case 'yellow':
      // 分数翻倍食物
      player.scoreMultiplierActive = true;
      player.scoreMultiplierTimeLeft = 5000; // 5秒钟
      io.to(game.id).emit('scoreMultiplierActivated', {
        playerId: player.id,
        playerName: player.name,
        duration: 5000
      });
      break;
    case 'green':
      // 减速食物
      player.snake.speed = Math.min(300, (player.snake.speed || gameConfig.baseSpeed) + 30);
      break;
    case 'blue':
      // 穿墙食物
      player.powerUpActive = true;
      player.powerUpType = 'phase';
      player.powerUpTimeLeft = 5000; // 5秒
      break;
    case 'purple':
      // 无敌食物
      player.powerUpActive = true;
      player.powerUpType = 'invincible';
      player.powerUpTimeLeft = 5000; // 5秒
      break;
  }

  // 通知玩家获得能力
  if (player.powerUpActive) {
    io.to(game.id).emit('powerUpActivated', {
      playerId: player.id,
      playerName: player.name,
      powerUpType: player.powerUpType
    });
  }
}


// 辅助函数：生成随机颜色
function getRandomColor() {
const colors = [
'#FF5252', '#FF4081', '#E040FB', '#7C4DFF',
'#536DFE', '#448AFF', '#40C4FF', '#18FFFF',
'#64FFDA', '#69F0AE', '#B2FF59', '#EEFF41',
'#FFFF00', '#FFD740', '#FFAB40', '#FF6E40'
];
return colors[Math.floor(Math.random() * colors.length)];
}

// 生成游戏ID
function generateGameId() {
  return Math.floor(1000 + Math.random() * 9000).toString(); // 生成1000-9999之间的数字
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`局域网玩家可以连接到 http://您的IP:${PORT}`);
  console.log(`当前工作目录: ${__dirname}`);
  
  // 列出文件目录以帮助调试
  console.log('当前目录文件:');
  try {
    const files = fs.readdirSync(__dirname);
    files.forEach(file => console.log('- ' + file));
  } catch (err) {
    console.error('列出文件时出错:', err);
  }
});

