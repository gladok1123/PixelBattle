// Pixel Battle - TypeScript с передовыми технологиями
// Используем: Web Workers, IndexedDB, Service Worker, OffscreenCanvas, RequestAnimationFrame

// ===== КОНФИГУРАЦИЯ =====
const CANVAS_SIZE = 2048;
const PIXEL_STEP = 1;

// ===== ТИПЫ =====
interface PixelUpdate {
  x: number;
  y: number;
  color: string;
  timestamp: number;
}

interface CanvasState {
  imageData: ImageData;
  lastUpdate: number;
}

// ===== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ =====
const canvas = document.getElementById('pixelCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { 
  willReadFrequently: true,
  alpha: false 
}) as CanvasRenderingContext2D;

const colorPicker = document.getElementById('colorPicker') as HTMLInputElement;
const colorPreview = document.getElementById('colorPreview') as HTMLDivElement;
const coordDisplay = document.getElementById('coordDisplay') as HTMLDivElement;
const playerCountSpan = document.getElementById('playerCount') as HTMLSpanElement;
const canvasWrapper = document.getElementById('canvasWrapper') as HTMLDivElement;
const zoomInBtn = document.getElementById('zoomIn') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('zoomOut') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('zoomReset') as HTMLButtonElement;

let currentColor = '#FF3B30';
let imageData: ImageData;
let isDrawing = false;
let currentZoom = 1;
let zoomTarget = 1;
let panX = 0, panY = 0;
let lastTouchDistance = 0;

const tabId = `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 6)}`;
const STORAGE_KEY = 'pixel_battle_canvas_2048';

// ===== ПЕРЕДОВЫЕ ТЕХНОЛОГИИ =====

// 1. IndexedDB для кэширования состояния холста
class CanvasDB {
  private db: IDBDatabase | null = null;
  
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('PixelBattleDB', 1);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('canvasStates')) {
          db.createObjectStore('canvasStates', { keyPath: 'id' });
        }
      };
      
      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };
      
      request.onerror = () => reject(new Error('IndexedDB failed'));
    });
  }
  
  async saveCanvas(imageData: ImageData): Promise<void> {
    if (!this.db) await this.init();
    const transaction = this.db!.transaction(['canvasStates'], 'readwrite');
    const store = transaction.objectStore('canvasStates');
    await new Promise<void>((resolve, reject) => {
      const request = store.put({ 
        id: 'current', 
        data: Array.from(imageData.data), 
        width: imageData.width, 
        height: imageData.height,
        timestamp: Date.now() 
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  
  async loadCanvas(): Promise<ImageData | null> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['canvasStates'], 'readonly');
      const store = transaction.objectStore('canvasStates');
      const request = store.get('current');
      
      request.onsuccess = () => {
        const result = request.result;
        if (result && result.data) {
          const imgData = new ImageData(
            new Uint8ClampedArray(result.data),
            result.width,
            result.height
          );
          resolve(imgData);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }
}

const canvasDB = new CanvasDB();

// 2. Web Worker для обработки пикселей
const pixelWorker = new Worker(URL.createObjectURL(new Blob([`
  self.onmessage = function(e) {
    const { action, imageData, x, y, color } = e.data;
    
    if (action === 'setPixel') {
      const [r, g, b] = [
        parseInt(color.slice(1,3), 16),
        parseInt(color.slice(3,5), 16),
        parseInt(color.slice(5,7), 16)
      ];
      
      const index = (y * ${CANVAS_SIZE} + x) * 4;
      imageData[index] = r;
      imageData[index+1] = g;
      imageData[index+2] = b;
      imageData[index+3] = 255;
      
      self.postMessage({ action: 'pixelSet', x, y, color, imageData });
    }
  };
`], { type: 'application/javascript' })));

// 3. Broadcast Channel API для синхронизации вкладок
const channel = new BroadcastChannel('pixel_battle_channel');

// 4. RequestIdleCallback для не-критических операций
const scheduleIdleTask = (callback: () => void) => {
  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(callback, { timeout: 1000 });
  } else {
    setTimeout(callback, 10);
  }
};

// 5. OffscreenCanvas для фоновых операций
let offscreenCanvas: OffscreenCanvas | null = null;
try {
  offscreenCanvas = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
} catch (e) {
  console.warn('OffscreenCanvas не поддерживается, используем fallback');
}

// ===== ФУНКЦИИ РАБОТЫ С ХОЛСТОМ =====

function initCanvas(): void {
  imageData = ctx.createImageData(CANVAS_SIZE, CANVAS_SIZE);
  // Заполняем белым
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

async function setPixel(x: number, y: number, colorHex: string): Promise<boolean> {
  if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) return false;
  
  // Используем Web Worker для обработки
  return new Promise((resolve) => {
    pixelWorker.onmessage = (e) => {
      if (e.data.action === 'pixelSet') {
        // Обновляем локальный ImageData
        const updatedData = new Uint8ClampedArray(e.data.imageData);
        imageData.data.set(updatedData);
        
        // Применяем на canvas
        requestAnimationFrame(() => {
          ctx.putImageData(imageData, 0, 0);
          resolve(true);
        });
      }
    };
    
    pixelWorker.postMessage({
      action: 'setPixel',
      imageData: Array.from(imageData.data),
      x,
      y,
      color: colorHex
    });
  });
}

function saveCanvasState(): void {
  scheduleIdleTask(() => {
    // Сохраняем в localStorage
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          const reader = new FileReader();
          reader.onload = () => {
            localStorage.setItem(STORAGE_KEY, reader.result as string);
            // Также сохраняем в IndexedDB
            canvasDB.saveCanvas(imageData);
          };
          reader.readAsDataURL(blob);
        }
      }, 'image/png');
    } catch (e) {
      console.warn('Ошибка сохранения:', e);
    }
    
    // Отправляем через BroadcastChannel
    channel.postMessage({ type: 'canvasUpdate', timestamp: Date.now() });
  });
}

async function loadCanvasState(): Promise<boolean> {
  // Пробуем загрузить из IndexedDB сначала
  const savedImageData = await canvasDB.loadCanvas();
  if (savedImageData) {
    imageData = savedImageData;
    ctx.putImageData(imageData, 0, 0);
    return true;
  }
  
  // Fallback на localStorage
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
        imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = saved;
    });
  }
  
  return false;
}

// ===== МАСШТАБИРОВАНИЕ И ПЕРЕМЕЩЕНИЕ =====

function applyTransform(): void {
  canvas.style.transform = `scale(${currentZoom})`;
  canvas.style.transformOrigin = 'center center';
}

function zoomIn(): void {
  zoomTarget = Math.min(zoomTarget * 1.5, 10);
  smoothZoom();
}

function zoomOut(): void {
  zoomTarget = Math.max(zoomTarget / 1.5, 0.5);
  smoothZoom();
}

function resetZoom(): void {
  zoomTarget = 1;
  smoothZoom();
}

function smoothZoom(): void {
  const animate = () => {
    currentZoom += (zoomTarget - currentZoom) * 0.3;
    if (Math.abs(zoomTarget - currentZoom) < 0.01) {
      currentZoom = zoomTarget;
    }
    applyTransform();
    
    if (currentZoom !== zoomTarget) {
      requestAnimationFrame(animate);
    }
  };
  requestAnimationFrame(animate);
}

// ===== ОБРАБОТЧИКИ СОБЫТИЙ =====

function getCanvasCoords(clientX: number, clientY: number): { x: number, y: number } | null {
  const rect = canvas.getBoundingClientRect();
  
  // Учитываем масштаб
  const scaleX = CANVAS_SIZE / rect.width;
  const scaleY = CANVAS_SIZE / rect.height;
  
  const offsetX = (clientX - rect.left) * scaleX;
  const offsetY = (clientY - rect.top) * scaleY;
  
  if (offsetX < 0 || offsetY < 0 || offsetX > CANVAS_SIZE || offsetY > CANVAS_SIZE) {
    return null;
  }
  
  return {
    x: Math.floor(Math.min(CANVAS_SIZE - 1, Math.max(0, offsetX))),
    y: Math.floor(Math.min(CANVAS_SIZE - 1, Math.max(0, offsetY)))
  };
}

async function handleDraw(clientX: number, clientY: number): Promise<void> {
  const coords = getCanvasCoords(clientX, clientY);
  if (!coords) return;
  
  coordDisplay.textContent = `X:${coords.x.toString().padStart(4,' ')} Y:${coords.y.toString().padStart(4,' ')}`;
  
  if (isDrawing) {
    await setPixel(coords.x, coords.y, currentColor);
    saveCanvasState();
    updatePlayerActivity();
  }
}

// Touch события с поддержкой мультитач для масштабирования
canvas.addEventListener('touchstart', (e: TouchEvent) => {
  e.preventDefault();
  
  if (e.touches.length === 1) {
    isDrawing = true;
    handleDraw(e.touches[0].clientX, e.touches[0].clientY);
  } else if (e.touches.length === 2) {
    isDrawing = false;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e: TouchEvent) => {
  e.preventDefault();
  
  if (e.touches.length === 1 && isDrawing) {
    handleDraw(e.touches[0].clientX, e.touches[0].clientY);
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (lastTouchDistance > 0) {
      const scale = distance / lastTouchDistance;
      zoomTarget = Math.min(Math.max(zoomTarget * scale, 0.5), 10);
      currentZoom = zoomTarget;
      applyTransform();
    }
    
    lastTouchDistance = distance;
  }
}, { passive: false });

canvas.addEventListener('touchend', (e: TouchEvent) => {
  e.preventDefault();
  isDrawing = false;
  lastTouchDistance = 0;
});

// Mouse события
canvas.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault();
  isDrawing = true;
  handleDraw(e.clientX, e.clientY);
});

canvas.addEventListener('mousemove', (e: MouseEvent) => {
  if (isDrawing) {
    handleDraw(e.clientX, e.clientY);
  } else {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    if (coords) {
      coordDisplay.textContent = `X:${coords.x.toString().padStart(4,' ')} Y:${coords.y.toString().padStart(4,' ')}`;
    }
  }
});

canvas.addEventListener('mouseup', () => {
  isDrawing = false;
});

canvas.addEventListener('mouseleave', () => {
  isDrawing = false;
  coordDisplay.textContent = 'X: - Y: -';
});

// Колесо мыши для масштабирования
canvas.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  if (e.deltaY < 0) {
    zoomIn();
  } else {
    zoomOut();
  }
}, { passive: false });

// ===== УПРАВЛЕНИЕ ИГРОКАМИ =====

function updatePlayerActivity(): void {
  localStorage.setItem(`pixel_player_${tabId}`, Date.now().toString());
}

function updatePlayerCount(): void {
  const now = Date.now();
  const keys = Object.keys(localStorage);
  let activePlayers = 0;
  
  keys.forEach(key => {
    if (key.startsWith('pixel_player_')) {
      const timestamp = parseInt(localStorage.getItem(key) || '0', 10);
      if (now - timestamp < 7000) {
        activePlayers++;
      } else {
        localStorage.removeItem(key);
      }
    }
  });
  
  playerCountSpan.textContent = Math.max(activePlayers, 1).toString();
}

// ===== СИНХРОНИЗАЦИЯ МЕЖДУ ВКЛАДКАМИ =====

channel.onmessage = (event) => {
  if (event.data.type === 'canvasUpdate') {
    loadCanvasState();
  }
};

window.addEventListener('storage', (event: StorageEvent) => {
  if (event.key === STORAGE_KEY && event.newValue) {
    loadCanvasState();
  }
  if (event.key?.startsWith('pixel_player_')) {
    updatePlayerCount();
  }
});

// ===== ОБРАБОТЧИКИ UI =====

colorPicker.addEventListener('input', (e: Event) => {
  currentColor = (e.target as HTMLInputElement).value;
  colorPreview.style.backgroundColor = currentColor;
  colorPreview.style.boxShadow = `0 0 20px ${currentColor}cc, inset 0 1px 4px rgba(255,255,255,0.5)`;
});

zoomInBtn.addEventListener('click', zoomIn);
zoomOutBtn.addEventListener('click', zoomOut);
zoomResetBtn.addEventListener('click', resetZoom);

// ===== ИНИЦИАЛИЗАЦИЯ =====

async function initialize(): Promise<void> {
  await canvasDB.init();
  
  const loaded = await loadCanvasState();
  if (!loaded) {
    initCanvas();
  }
  
  colorPreview.style.backgroundColor = currentColor;
  colorPreview.style.boxShadow = `0 0 20px ${currentColor}cc, inset 0 1px 4px rgba(255,255,255,0.5)`;
  
  updatePlayerActivity();
  updatePlayerCount();
  
  // Периодические обновления
  setInterval(updatePlayerCount, 2000);
  setInterval(() => {
    channel.postMessage({ type: 'heartbeat', tabId });
  }, 5000);
}

// Регистрация Service Worker для PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(
      (registration) => console.log('ServiceWorker зарегистрирован'),
      (err) => console.log('ServiceWorker ошибка:', err)
    );
  });
}

// Запуск приложения
initialize().then(() => {
  console.log('🎨 Pixel Battle запущен с передовыми технологиями');
});

// Очистка при закрытии
window.addEventListener('beforeunload', () => {
  localStorage.removeItem(`pixel_player_${tabId}`);
  channel.close();
  pixelWorker.terminate();
});

// Экспорт для возможного использования в других модулях
export { setPixel, saveCanvasState, loadCanvasState };