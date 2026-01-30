/**
 * RemoteStorage Injector
 * ----------------------
 * Перехватывает IndexedDB до загрузки Construct‑runtime и
 * перенаправляет операции put/get/delete на WebSocket‑сервер.
 * Токен авторизации берётся из URL (?token=...).
 *
 * Подключать строго перед main.js и другими скриптами Construct.
 */

const REMOTE_ADDRESS = 'example.com';
const LISTENING_PORT = 16666;

const urlParams = new URLSearchParams(window.location.search);
const AUTH_TOKEN = urlParams.get("token");

console.log("Token from URL:", AUTH_TOKEN);

// Создаем WebSocket соединение
window.gameSocket = new WebSocket(`wss://${REMOTE_ADDRESS}:${LISTENING_PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`);

// Очередь ожидающих запросов
const pendingRequests = new Map();
let requestCounter = 0;

// Активные транзакции
const activeTransactions = new Map();

// Keepalive интервал
let keepaliveInterval = null;
const KEEPALIVE_INTERVAL = 30000; // 30 секунд

// Функция для создания HTML-фрейма ошибки
function createErrorFrame(message) {
    const frame = document.createElement('div');
    frame.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.9);
        color: white;
        z-index: 999999;
        font-family: Arial, sans-serif;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 20px;
        box-sizing: border-box;
        pointer-events: auto;
    `;
    
    const title = document.createElement('h1');
    title.textContent = 'Connection Error';
    title.style.cssText = `
        color: #ff6b6b;
        font-size: 2.5em;
        margin-bottom: 20px;
    `;
    
    const errorText = document.createElement('p');
    errorText.textContent = message;
    errorText.style.cssText = `
        font-size: 1.2em;
        line-height: 1.5;
        max-width: 600px;
        margin-bottom: 30px;
    `;
    
    const instruction = document.createElement('p');
    instruction.textContent = 'Please close this page and reopen it with a valid link.';
    instruction.style.cssText = `
        font-size: 1em;
        color: #aaa;
        margin-bottom: 40px;
    `;
    
    const button = document.createElement('button');
    button.textContent = 'Refresh Page';
    button.style.cssText = `
        background: #4ecdc4;
        color: white;
        border: none;
        padding: 15px 30px;
        font-size: 1.1em;
        border-radius: 5px;
        cursor: pointer;
        transition: background 0.3s;
        pointer-events: auto;
    `;
    button.onmouseover = () => button.style.background = '#3db8af';
    button.onmouseout = () => button.style.background = '#4ecdc4';
    button.onclick = () => location.reload();
    
    frame.appendChild(title);
    frame.appendChild(errorText);
    frame.appendChild(instruction);
    frame.appendChild(button);
    
    // Останавливаем любую игру или анимацию
    if (window.cr_getC2Runtime) {
        const runtime = window.cr_getC2Runtime();
        if (runtime && runtime.pauseGame) {
            runtime.pauseGame();
        }
    }
    
    // Блокируем взаимодействие с игрой, но не с фреймом ошибки
    document.body.style.pointerEvents = 'none';
    document.body.style.overflow = 'hidden';
    frame.style.pointerEvents = 'auto';
    
    return frame;
}

// Функция для отправки keepalive сообщения
function sendKeepalive() {
    if (window.gameSocket && window.gameSocket.readyState === WebSocket.OPEN) {
        try {
            console.log("[WS] Sending keepalive ping");
            // Отправляем пустое сообщение или специальный keepalive пакет
            window.gameSocket.send(JSON.stringify({
                type: "keepalive",
                timestamp: Date.now()
            }));
        } catch (error) {
            console.error("[WS] Error sending keepalive:", error);
        }
    } else {
        console.log("[WS] Cannot send keepalive - WebSocket not open");
    }
}

// Функция для запуска keepalive интервала
function startKeepalive() {
    console.log("[WS] Starting keepalive interval");
    // Очищаем старый интервал, если есть
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
    }
    
    // Запускаем новый интервал
    keepaliveInterval = setInterval(sendKeepalive, KEEPALIVE_INTERVAL);
    
    // Сразу отправляем первый keepalive
    setTimeout(sendKeepalive, 5000); // Через 5 секунд после подключения
}

// Функция для остановки keepalive интервала
function stopKeepalive() {
    console.log("[WS] Stopping keepalive interval");
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
    }
}

// Обработчики WebSocket
gameSocket.addEventListener("open", () => {
    console.log("[WS] Connected with token:", AUTH_TOKEN);
    // Запускаем keepalive при открытии соединения
    startKeepalive();
});

gameSocket.addEventListener("error", (err) => {
    console.error("[WS] Connection error:", err);
    stopKeepalive(); // Останавливаем keepalive при ошибке
    const errorFrame = createErrorFrame("Cannot connect to game server. Please check your internet connection.");
    document.body.appendChild(errorFrame);
});

gameSocket.addEventListener("close", (event) => {
    console.warn("[WS] Connection closed:", event.code, event.reason);
    stopKeepalive(); // Останавливаем keepalive при закрытии
    
    // Завершаем все ожидающие запросы
    pendingRequests.forEach((request, requestId) => {
        console.log(`[WS] Cleaning up pending request ${requestId}`);
        if (request.onerror) {
            const errorEvent = new Event('error');
            errorEvent.target = { 
                error: new Error(event.reason || "WebSocket connection closed") 
            };
            request.onerror(errorEvent);
        }
    });
    pendingRequests.clear();
    
    // Завершаем все активные транзакции
    activeTransactions.forEach((transaction, transactionId) => {
        console.log(`[WS] Cleaning up active transaction ${transactionId}`);
        if (transaction.onerror) {
            const errorEvent = new Event('error');
            errorEvent.target = { 
                error: new Error(event.reason || "WebSocket connection closed") 
            };
            transaction.onerror(errorEvent);
        }
    });
    activeTransactions.clear();
    
    // Показываем ошибку только если соединение было установлено и потом разорвано
    if (event.code !== 1000) {
        const errorFrame = createErrorFrame(
            event.reason || "Connection to game server lost. Please refresh the page."
        );
        document.body.appendChild(errorFrame);
    }
});

// Обработка ответов от сервера
gameSocket.addEventListener("message", (event) => {
    try {
        console.log("[WS] Raw message from server:", event.data);
        const response = JSON.parse(event.data);
        console.log("[WS] Parsed response:", response);
        
        // Проверка на глобальные ошибки аутентификации
        if (response.error && response.errorName === "SecurityError") {
            console.error("[WS] Security error:", response.error);
            const errorFrame = createErrorFrame("Authentication failed. Please use a valid game link.");
            document.body.appendChild(errorFrame);
            gameSocket.close();
            return;
        }
        
        // Игнорируем keepalive ответы от сервера (если они есть)
        if (response.type === "keepalive_response") {
            console.log("[WS] Received keepalive response");
            return;
        }
        
        if (response.id !== undefined) {
            const request = pendingRequests.get(response.id);
            if (request) {
                console.log(`[WS] Found pending request ${response.id}, request object:`, request);
                pendingRequests.delete(response.id);
                
                // Удаляем запрос из списка ожидания транзакции, если она существует
                if (request.transaction && request.transaction._removePendingRequest) {
                    request.transaction._removePendingRequest(response.id);
                }
                
                if (response.error) {
                    // Эмуляция ошибки IndexedDB
                    const error = new Error(response.error);
                    error.name = response.errorName || "UnknownError";
                    console.log(`[WS] Request ${response.id} error:`, error);
                    
                    request.error = error;
                    request.readyState = 'done';
                    
                    if (request.onerror) {
                        console.log(`[WS] Calling onerror for request ${response.id}`);
                        const errorEvent = new Event('error');
                        errorEvent.target = { error: error };
                        request.onerror(errorEvent);
                    }
                    
                    // Также вызываем error callbacks от addEventListener
                    if (request._errorCallbacks) {
                        request._errorCallbacks.forEach(callback => {
                            try {
                                const errorEvent = new Event('error');
                                errorEvent.target = { error: error };
                                callback(errorEvent);
                            } catch (e) {
                                console.error("[WS] Error in error callback:", e);
                            }
                        });
                    }
                } else {
                    // Успешный ответ
                    console.log(`[WS] Request ${response.id} success, result:`, response.result);
                    request.result = response.result;
                    request.readyState = 'done';
                    
                    if (request.onsuccess) {
                        console.log(`[WS] Calling onsuccess for request ${response.id}`);
                        const successEvent = new Event('success');
                        successEvent.target = { 
                            result: response.result 
                        };
                        request.onsuccess(successEvent);
                    }
                    
                    // Также вызываем success callbacks от addEventListener
                    if (request._successCallbacks) {
                        request._successCallbacks.forEach(callback => {
                            try {
                                const successEvent = new Event('success');
                                successEvent.target = { result: response.result };
                                callback(successEvent);
                            } catch (e) {
                                console.error("[WS] Error in success callback:", e);
                            }
                        });
                    }
                }
            } else {
                console.warn(`[WS] No pending request found for id ${response.id}`);
                console.log("[WS] Current pending requests:", Array.from(pendingRequests.keys()));
            }
        } else {
            console.warn("[WS] Response without id:", response);
        }
    } catch (e) {
        console.error("[WS] Failed to parse response:", e, "Raw data:", event.data);
    }
});

// Запускаем keepalive при загрузке страницы, если соединение уже открыто
if (window.gameSocket.readyState === WebSocket.OPEN) {
    startKeepalive();
}

// Также добавляем keepalive при изменении видимости страницы (когда пользователь возвращается на вкладку)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.gameSocket.readyState === WebSocket.OPEN) {
        console.log("[WS] Page became visible, sending keepalive");
        sendKeepalive();
    }
});

(function() {
    // Вспомогательная функция для создания объекта запроса
    function createRequest() {
        const req = {
            result: undefined,
            error: undefined,
            onsuccess: null,
            onerror: null,
            source: null,
            transaction: null,
            readyState: 'pending',
            _successCallbacks: [],
            _errorCallbacks: []
        };
        
        // Эмуляция EventTarget методов
        req.addEventListener = function(type, callback) {
            if (type === 'success') {
                this._successCallbacks.push(callback);
                console.log(`[IDB] Added success callback, total: ${this._successCallbacks.length}`);
            } else if (type === 'error') {
                this._errorCallbacks.push(callback);
                console.log(`[IDB] Added error callback, total: ${this._errorCallbacks.length}`);
            }
        };
        
        return req;
    }

    // Полностью перехватываем IndexedDB и эмулируем его работу через WebSocket
    const originalIndexedDB = window.indexedDB;
    
    // Словарь для хранения созданных хранилищ
    const mockStores = new Map();
    
    // Перехватываем indexedDB.open
    window.indexedDB.open = function(name, version) {
        console.log("[IDB] Mock open request for:", name, version);
        
        const request = createRequest();
        
        // Имитируем асинхронное открытие
        setTimeout(() => {
            // Создаем мок-объект базы данных
            const db = {
                name: name,
                version: version || 1,
                objectStoreNames: [],
                transaction: function(storeNames, mode) {
                    console.log("[IDB] Mock transaction for stores:", storeNames, "mode:", mode);
                    
                    const transactionId = 'trans_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    
                    const transaction = {
                        db: db,
                        mode: mode || 'readonly',
                        storeNames: Array.isArray(storeNames) ? storeNames : [storeNames],
                        error: null,
                        oncomplete: null,
                        onerror: null,
                        onabort: null,
                        _id: transactionId,
                        _pendingRequests: new Set(),
                        
                        abort: function() {
                            console.log("[IDB] Transaction aborted:", this._id);
                            activeTransactions.delete(this._id);
                            
                            if (this.onabort) {
                                const abortEvent = new Event('abort');
                                abortEvent.target = this;
                                this.onabort(abortEvent);
                            }
                        },
                        
                        _checkComplete: function() {
                            console.log(`[IDB] Transaction ${this._id} check complete, pending requests:`, this._pendingRequests.size);
                            
                            // Если нет ожидающих запросов, завершаем транзакцию
                            if (this._pendingRequests.size === 0) {
                                console.log(`[IDB] Transaction ${this._id} all requests completed, triggering oncomplete`);
                                setTimeout(() => {
                                    if (this.oncomplete) {
                                        const completeEvent = new Event('complete');
                                        completeEvent.target = this;
                                        this.oncomplete(completeEvent);
                                    }
                                    activeTransactions.delete(this._id);
                                }, 0);
                            }
                        },
                        
                        _addPendingRequest: function(requestId) {
                            this._pendingRequests.add(requestId);
                            console.log(`[IDB] Transaction ${this._id} added pending request ${requestId}, total:`, this._pendingRequests.size);
                        },
                        
                        _removePendingRequest: function(requestId) {
                            this._pendingRequests.delete(requestId);
                            console.log(`[IDB] Transaction ${this._id} removed pending request ${requestId}, remaining:`, this._pendingRequests.size);
                            this._checkComplete();
                        },
                        
                        objectStore: function(storeName) {
                            console.log("[IDB] Getting object store from transaction:", storeName);
                            
                            // Создаем мок-объект хранилища
                            const store = {
                                name: storeName,
                                keyPath: null,
                                autoIncrement: false,
                                indexNames: [],
                                transaction: transaction,
                                
                                put: function(value, key) {
                                    console.log(`[IDB] store.put called, key:`, key, "value:", value);
                                    const req = createRequest();
                                    req.transaction = transaction;
                                    
                                    if (window.gameSocket?.readyState === WebSocket.OPEN) {
                                        const requestId = ++requestCounter;
                                        pendingRequests.set(requestId, req);
                                        transaction._addPendingRequest(requestId);
                                        
                                        console.log(`[IDB] Sending put request ${requestId} for key:`, key);
                                        
                                        window.gameSocket.send(JSON.stringify({
                                            id: requestId,
                                            op: "put",
                                            key: key,
                                            value: value
                                        }));
                                    } else {
                                        console.log(`[IDB] WebSocket not open, state:`, window.gameSocket?.readyState);
                                        setTimeout(() => {
                                            const errorId = 'error_' + Date.now();
                                            transaction._addPendingRequest(errorId);
                                            setTimeout(() => {
                                                transaction._removePendingRequest(errorId);
                                                if (req.onerror) {
                                                    const errorEvent = new Event('error');
                                                    errorEvent.target = { 
                                                        error: new Error("WebSocket not connected") 
                                                    };
                                                    req.onerror(errorEvent);
                                                }
                                            }, 0);
                                        }, 0);
                                    }
                                    return req;
                                },
                                
                                get: function(key) {
                                    console.log(`[IDB] store.get called, key:`, key);
                                    const req = createRequest();
                                    req.transaction = transaction;
                                    
                                    if (window.gameSocket?.readyState === WebSocket.OPEN) {
                                        const requestId = ++requestCounter;
                                        pendingRequests.set(requestId, req);
                                        transaction._addPendingRequest(requestId);
                                        
                                        console.log(`[IDB] Sending get request ${requestId} for key:`, key);
                                        
                                        window.gameSocket.send(JSON.stringify({
                                            id: requestId,
                                            op: "get",
                                            key: key
                                        }));
                                    } else {
                                        console.log(`[IDB] WebSocket not open, state:`, window.gameSocket?.readyState);
                                        setTimeout(() => {
                                            const errorId = 'error_' + Date.now();
                                            transaction._addPendingRequest(errorId);
                                            setTimeout(() => {
                                                transaction._removePendingRequest(errorId);
                                                if (req.onerror) {
                                                    const errorEvent = new Event('error');
                                                    errorEvent.target = { 
                                                        error: new Error("WebSocket not connected") 
                                                    };
                                                    req.onerror(errorEvent);
                                                }
                                            }, 0);
                                        }, 0);
                                    }
                                    return req;
                                },
                                
                                delete: function(key) {
                                    console.log(`[IDB] store.delete called, key:`, key);
                                    const req = createRequest();
                                    req.transaction = transaction;
                                    
                                    if (window.gameSocket?.readyState === WebSocket.OPEN) {
                                        const requestId = ++requestCounter;
                                        pendingRequests.set(requestId, req);
                                        transaction._addPendingRequest(requestId);
                                        
                                        console.log(`[IDB] Sending delete request ${requestId} for key:`, key);
                                        
                                        window.gameSocket.send(JSON.stringify({
                                            id: requestId,
                                            op: "delete",
                                            key: key
                                        }));
                                    } else {
                                        console.log(`[IDB] WebSocket not open, state:`, window.gameSocket?.readyState);
                                        setTimeout(() => {
                                            const errorId = 'error_' + Date.now();
                                            transaction._addPendingRequest(errorId);
                                            setTimeout(() => {
                                                transaction._removePendingRequest(errorId);
                                                if (req.onerror) {
                                                    const errorEvent = new Event('error');
                                                    errorEvent.target = { 
                                                        error: new Error("WebSocket not connected") 
                                                    };
                                                    req.onerror(errorEvent);
                                                }
                                            }, 0);
                                        }, 0);
                                    }
                                    return req;
                                },
                                
                                // Заглушки для других методов - они не должны влиять на транзакцию
                                openCursor: function() {
                                    console.log(`[IDB] store.openCursor called`);
                                    const req = createRequest();
                                    setTimeout(() => {
                                        if (req.onsuccess) {
                                            const successEvent = new Event('success');
                                            successEvent.target = { result: null };
                                            req.onsuccess(successEvent);
                                        }
                                    }, 0);
                                    return req;
                                },
                                
                                clear: function() {
                                    console.log(`[IDB] store.clear called`);
                                    const req = createRequest();
                                    req.transaction = transaction;
                                    const clearId = 'clear_' + Date.now();
                                    transaction._addPendingRequest(clearId);
                                    
                                    setTimeout(() => {
                                        transaction._removePendingRequest(clearId);
                                        if (req.onsuccess) {
                                            const successEvent = new Event('success');
                                            successEvent.target = { result: undefined };
                                            req.onsuccess(successEvent);
                                        }
                                    }, 0);
                                    return req;
                                },
                                
                                index: function() {
                                    console.log(`[IDB] store.index called`);
                                    return {
                                        get: function() {
                                            const req = createRequest();
                                            setTimeout(() => {
                                                if (req.onsuccess) {
                                                    const successEvent = new Event('success');
                                                    successEvent.target = { result: null };
                                                    req.onsuccess(successEvent);
                                                }
                                            }, 0);
                                            return req;
                                        }
                                    };
                                },
                                
                                getAll: function() {
                                    console.log(`[IDB] store.getAll called`);
                                    const req = createRequest();
                                    setTimeout(() => {
                                        if (req.onsuccess) {
                                            const successEvent = new Event('success');
                                            successEvent.target = { result: [] };
                                            req.onsuccess(successEvent);
                                        }
                                    }, 0);
                                    return req;
                                },
                                
                                count: function() {
                                    console.log(`[IDB] store.count called`);
                                    const req = createRequest();
                                    setTimeout(() => {
                                        if (req.onsuccess) {
                                            const successEvent = new Event('success');
                                            successEvent.target = { result: 0 };
                                            req.onsuccess(successEvent);
                                        }
                                    }, 0);
                                    return req;
                                },
                                
                                // Для отладки
                                toString: function() {
                                    return `[MockObjectStore: ${this.name}]`;
                                }
                            };
                            
                            // Добавляем хранилище в список, если его еще нет
                            if (!db.objectStoreNames.contains(storeName)) {
                                db.objectStoreNames.push(storeName);
                            }
                            
                            return store;
                        }
                    };
                    
                    // Сохраняем транзакцию в активных
                    activeTransactions.set(transactionId, transaction);
                    
                    // Не завершаем транзакцию автоматически - ждем завершения всех запросов
                    console.log(`[IDB] Transaction ${transactionId} created, waiting for requests to complete`);
                    
                    return transaction;
                },
                
                createObjectStore: function(storeName, options) {
                    console.log("[IDB] Creating object store:", storeName, "options:", options);
                    
                    if (db.objectStoreNames.contains(storeName)) {
                        throw new DOMException("An object store with that name already exists.", "ConstraintError");
                    }
                    
                    // Создаем хранилище через транзакцию
                    const transaction = db.transaction([storeName], 'readwrite');
                    const store = transaction.objectStore(storeName);
                    
                    // Сохраняем настройки
                    if (options) {
                        store.keyPath = options.keyPath || null;
                        store.autoIncrement = options.autoIncrement || false;
                    }
                    
                    db.objectStoreNames.push(storeName);
                    mockStores.set(storeName, store);
                    
                    // Сразу завершаем транзакцию создания (не ждем запросов)
                    setTimeout(() => {
                        if (transaction.oncomplete) {
                            const completeEvent = new Event('complete');
                            completeEvent.target = transaction;
                            transaction.oncomplete(completeEvent);
                        }
                        activeTransactions.delete(transaction._id);
                    }, 10);
                    
                    return store;
                },
                
                close: function() {
                    console.log("[IDB] Database closed");
                },
                
                // Для отладки
                toString: function() {
                    return `[MockDatabase: ${this.name} v${this.version}]`;
                }
            };
            
            // Добавляем метод contains для objectStoreNames
            db.objectStoreNames.contains = function(name) {
                return this.indexOf(name) !== -1;
            };
            
            request.result = db;
            request.readyState = 'done';
            console.log("[IDB] Database opened successfully:", db);
            
            // Вызываем onsuccess
            if (request.onsuccess) {
                console.log("[IDB] Calling original onsuccess handler");
                const successEvent = new Event('success');
                successEvent.target = request;
                request.onsuccess(successEvent);
            }
            
            // Вызываем addEventListener handlers
            if (request._successCallbacks) {
                console.log(`[IDB] Calling ${request._successCallbacks.length} success callbacks`);
                request._successCallbacks.forEach(callback => {
                    try {
                        const successEvent = new Event('success');
                        successEvent.target = request;
                        callback(successEvent);
                    } catch (e) {
                        console.error("[IDB] Error in success callback:", e);
                    }
                });
            }
        }, 0);
        
        return request;
    };
    
    // Перехватываем другие методы IndexedDB
    window.indexedDB.deleteDatabase = function(name) {
        console.log("[IDB] Mock deleteDatabase:", name);
        
        const request = createRequest();
        
        setTimeout(() => {
            // Очищаем связанные хранилища
            mockStores.clear();
            
            if (request.onsuccess) {
                const successEvent = new Event('success');
                successEvent.target = request;
                request.onsuccess(successEvent);
            }
        }, 0);
        
        return request;
    };
    
    // Эмулируем остальные свойства IndexedDB
    window.indexedDB.cmp = originalIndexedDB.cmp || function() { return 0; };
    window.indexedDB.databases = originalIndexedDB.databases || function() {
        return Promise.resolve([]);
    };
    
    // Для отладки
    console.log("[IDB] IndexedDB has been successfully intercepted and mocked");
    
})();

// Добавляем глобальную функцию для отладки
window.debugRemoteStorage = {
    getPendingRequests: () => Array.from(pendingRequests.keys()),
    getRequestCounter: () => requestCounter,
    getWebSocketState: () => window.gameSocket?.readyState,
    getActiveTransactions: () => Array.from(activeTransactions.keys()),
    clearPendingRequests: () => {
        console.log("[DEBUG] Clearing all pending requests");
        pendingRequests.clear();
    },
    sendKeepalive: () => sendKeepalive(),
    simulateResponse: (id, result, error) => {
        const request = pendingRequests.get(id);
        if (request) {
            if (error) {
                request.error = new Error(error);
                if (request.onerror) {
                    const errorEvent = new Event('error');
                    errorEvent.target = { error: request.error };
                    request.onerror(errorEvent);
                }
            } else {
                request.result = result;
                if (request.onsuccess) {
                    const successEvent = new Event('success');
                    successEvent.target = { result: result };
                    request.onsuccess(successEvent);
                }
            }
            pendingRequests.delete(id);
        }
    }
};

console.log("[IDB] RemoteStorage Injector loaded successfully");
