import asyncio
import json
import os
import ssl
import websockets
import aiohttp
import aiomysql
from urllib.parse import urlparse, parse_qs
from typing import Dict, Optional
from dataclasses import dataclass
from datetime import datetime

@dataclass
class UserSession:
    token: str
    username: str

# CONFIG BEGIN

# Конфигурация SSL (можно задать через переменные окружения)
SSL_CERT_PATH = os.getenv("SSL_CERT_PATH", "/path/to/cert.pem")  
SSL_KEY_PATH = os.getenv("SSL_KEY_PATH", "/path/to/privkey.pem")
USE_SSL = os.getenv("USE_SSL", "true").lower() == "true"

# MySQL конфигурация
MYSQL_CONFIG = {
    'host': 'localhost',
    'user': 'user',
    'password': '****',
    'db': 'test',
    'port': 3306,
    'charset': 'utf8mb4',
    'autocommit': True
}

# Кэш пользовательских сессий в памяти (token -> UserSession)
user_sessions: Dict[str, UserSession] = {}

# URLы API
AUTH_API_URL = "https://dw.y-chain.net/rails/auth.php"
UINFO_API_URL = "https://dw.y-chain.net/rails/uinfo.php"

# Rails credentials
USERNAME = "user" 
PASSWORD = "****"

# CONFIG END

# Глобальная серверная сессия для API запросов
server_session: Optional[aiohttp.ClientSession] = None

# Пул соединений MySQL
mysql_pool: Optional[aiomysql.Pool] = None

def create_ssl_context():
    """Создает SSL контекст для WebSocket сервера"""
    if not USE_SSL:
        print("[SSL] SSL disabled")
        return None
    
    if not SSL_CERT_PATH or not SSL_KEY_PATH:
        print("[SSL] SSL enabled but certificate or key path not specified")
        return None
    
    if not os.path.exists(SSL_CERT_PATH):
        print(f"[SSL] Certificate file not found: {SSL_CERT_PATH}")
        return None
    
    if not os.path.exists(SSL_KEY_PATH):
        print(f"[SSL] Key file not found: {SSL_KEY_PATH}")
        return None
    
    try:
        # Создаем SSL контекст
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        
        # Загружаем сертификат и ключ
        ssl_context.load_cert_chain(SSL_CERT_PATH, SSL_KEY_PATH)
        
        # Настройки безопасности
        ssl_context.minimum_version = ssl.TLSVersion.TLSv1_2
        ssl_context.set_ciphers('ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:DHE+CHACHA20')
        ssl_context.options |= ssl.OP_NO_TLSv1 | ssl.OP_NO_TLSv1_1
        ssl_context.options |= ssl.OP_SINGLE_DH_USE
        ssl_context.options |= ssl.OP_SINGLE_ECDH_USE
        
        print(f"[SSL] SSL context created successfully")
        print(f"[SSL] Certificate: {SSL_CERT_PATH}")
        print(f"[SSL] Key: {SSL_KEY_PATH}")
        
        return ssl_context
        
    except Exception as e:
        print(f"[SSL] Failed to create SSL context: {e}")
        return None

async def create_mysql_pool():
    """Создает пул соединений с MySQL"""
    global mysql_pool
    try:
        mysql_pool = await aiomysql.create_pool(
            host=MYSQL_CONFIG['host'],
            port=MYSQL_CONFIG['port'],
            user=MYSQL_CONFIG['user'],
            password=MYSQL_CONFIG['password'],
            db=MYSQL_CONFIG['db'],
            charset=MYSQL_CONFIG['charset'],
            autocommit=MYSQL_CONFIG['autocommit'],
            minsize=1,
            maxsize=10
        )
        print(f"[DB] MySQL connection pool created successfully")
        return True
    except Exception as e:
        print(f"[DB] Failed to create MySQL pool: {e}")
        return False

async def close_mysql_pool():
    """Закрывает пул соединений с MySQL"""
    global mysql_pool
    if mysql_pool:
        mysql_pool.close()
        await mysql_pool.wait_closed()
        print(f"[DB] MySQL connection pool closed")

async def init_database():
    """Инициализирует таблицы в MySQL"""
    try:
        async with mysql_pool.acquire() as conn:
            async with conn.cursor() as cursor:
                # Таблица для пользовательских данных
                await cursor.execute('''
                    CREATE TABLE IF NOT EXISTS user_storage (
                        username VARCHAR(255) NOT NULL,
                        storage_key VARCHAR(255) NOT NULL,
                        value MEDIUMTEXT,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        PRIMARY KEY (username, storage_key),
                        INDEX idx_username (username),
                        INDEX idx_storage_key (storage_key)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                ''')
                
                # Таблица для логов операций
                await cursor.execute('''
                    CREATE TABLE IF NOT EXISTS operation_logs (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        username VARCHAR(255),
                        operation VARCHAR(50),
                        storage_key VARCHAR(255),
                        value MEDIUMTEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        INDEX idx_username_created (username, created_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                ''')
                
                # Проверяем таблицы
                await cursor.execute("SHOW TABLES")
                tables = await cursor.fetchall()
                table_names = [table[0] for table in tables]
                print(f"[DB] Tables in database: {table_names}")
                
        print(f"[DB] MySQL database initialized successfully")
        
    except Exception as e:
        print(f"[DB] MySQL initialization error: {e}")
        raise

async def log_operation(username: str, operation: str, storage_key: str, value: str = None):
    """Логирует операцию в MySQL"""
    try:
        async with mysql_pool.acquire() as conn:
            async with conn.cursor() as cursor:
                await cursor.execute('''
                    INSERT INTO operation_logs (username, operation, storage_key, value, created_at)
                    VALUES (%s, %s, %s, %s, NOW())
                ''', (username, operation, storage_key, value))
                
    except Exception as e:
        print(f"[DB] Error logging operation: {e}")

async def get_user_storage(username: str, storage_key: str) -> Optional[str]:
    """Получает значение из хранилища пользователя"""
    try:
        async with mysql_pool.acquire() as conn:
            async with conn.cursor() as cursor:
                await cursor.execute(
                    "SELECT value FROM user_storage WHERE username = %s AND storage_key = %s",
                    (username, storage_key)
                )
                result = await cursor.fetchone()
                
                value = result[0] if result else None
                if value:
                    print(f"[DB] Retrieved data for user '{username}', storage_key: '{storage_key}'")
                    await log_operation(username, "GET", storage_key, value)
                else:
                    print(f"[DB] No data found for user '{username}', storage_key: '{storage_key}'")
                    await log_operation(username, "GET", storage_key, "NOT_FOUND")
                
                return value
                
    except Exception as e:
        print(f"[DB] Get error: {e}")
        return None

async def set_user_storage(username: str, storage_key: str, value: str) -> bool:
    """Устанавливает значение в хранилище пользователя"""
    try:
        print(f"[DB] Saving data for user '{username}', storage_key: '{storage_key}'")
        
        async with mysql_pool.acquire() as conn:
            async with conn.cursor() as cursor:
                await cursor.execute('''
                    INSERT INTO user_storage (username, storage_key, value, updated_at)
                    VALUES (%s, %s, %s, NOW())
                    ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()
                ''', (username, storage_key, value))
                
        print(f"[DB] Successfully saved data for user '{username}', storage_key: '{storage_key}'")
        await log_operation(username, "PUT", storage_key, value)
        return True
            
    except Exception as e:
        print(f"[DB] Put error: {e}")
        return False

async def delete_user_storage(username: str, storage_key: str) -> bool:
    """Удаляет значение из хранилища пользователя"""
    try:
        print(f"[DB] Deleting data for user '{username}', storage_key: '{storage_key}'")
        
        async with mysql_pool.acquire() as conn:
            async with conn.cursor() as cursor:
                await cursor.execute(
                    "DELETE FROM user_storage WHERE username = %s AND storage_key = %s",
                    (username, storage_key)
                )
                rows_deleted = cursor.rowcount
        
        if rows_deleted > 0:
            print(f"[DB] Successfully deleted data for user '{username}', storage_key: '{storage_key}'")
            await log_operation(username, "DELETE", storage_key, "DELETED")
        else:
            print(f"[DB] No data to delete for user '{username}', storage_key: '{storage_key}'")
            await log_operation(username, "DELETE", storage_key, "NOT_FOUND")
        
        return True
    except Exception as e:
        print(f"[DB] Delete error: {e}")
        return False

async def create_server_session() -> bool:
    """Создает серверную сессию с аутентификацией"""
    global server_session
    
    try:
        # Закрываем старую сессию, если существует
        if server_session and not server_session.closed:
            await server_session.close()
        
        print(f"[SERVER] Creating new session with login...")
        
        # Создаем новую сессию
        server_session = aiohttp.ClientSession()
        
        # Логинимся как Silent58
        print(f"[SERVER] Logging in as {USERNAME}...")
        
        async with server_session.post(
            AUTH_API_URL,
            data={
                "username": USERNAME,
                "password": PASSWORD
            },
            timeout=10
        ) as response:
            response_text = await response.text()
            print(f"[SERVER] Login response status: {response.status}")
            
            if response.status == 200:
                try:
                    data = json.loads(response_text)
                    
                    if data.get("message") == "auth_success":
                        print(f"[SERVER] Successfully logged in as {USERNAME}")
                        
                        # Проверяем, что сессия работает, запрашивая информацию о себе
                        async with server_session.get(UINFO_API_URL, timeout=5) as test_response:
                            test_response_text = await test_response.text()
                            
                            if test_response.status == 200:
                                try:
                                    test_data = json.loads(test_response_text)
                                    
                                    if test_data.get("message") == "user_info_success":
                                        username_from_test = test_data['data']['user']['username']
                                        print(f"[SERVER] Session confirmed for user: {username_from_test}")
                                        return True
                                    else:
                                        print(f"[SERVER] Session test failed message: {test_data.get('message')}")
                                        return False
                                except json.JSONDecodeError as e:
                                    print(f"[SERVER] Failed to parse test response JSON: {e}")
                                    return False
                            else:
                                print(f"[SERVER] Session test HTTP error: {test_response.status}")
                                return False
                    else:
                        print(f"[SERVER] Login failed message: {data.get('message')}")
                        return False
                except json.JSONDecodeError as e:
                    print(f"[SERVER] Failed to parse login response JSON: {e}")
                    return False
            else:
                print(f"[SERVER] Login HTTP error: {response.status}")
                return False
                
    except Exception as e:
        print(f"[SERVER] Failed to create session: {e}")
        if server_session and not server_session.closed:
            await server_session.close()
        server_session = None
        return False

async def authenticate_token(token: str) -> Optional[str]:
    """Проверяет токен через API и возвращает username"""
    if not token or len(token) < 5:
        print(f"[AUTH] Invalid token: {token}")
        return None
    
    # Убеждаемся, что у нас есть валидная серверная сессия
    if server_session is None or server_session.closed:
        print(f"[AUTH] Server session not available, creating new one")
        if not await create_server_session():
            print(f"[AUTH] Failed to create server session")
            return None
    
    try:
        print(f"[AUTH] Requesting user info for token: {token}")
        
        # Используем серверную сессию с куками для запроса информации о пользователе
        async with server_session.get(
            UINFO_API_URL, 
            params={"token": token},
            timeout=5
        ) as response:
            response_text = await response.text()
            print(f"[AUTH] Response status: {response.status}")
            
            if response.status == 200:
                try:
                    data = json.loads(response_text)
                    
                    if data.get("message") == "user_info_success":
                        username = data["data"]["user"]["username"]
                        print(f"[AUTH] User authenticated: {username}")
                        
                        # Сохраняем сессию в памяти
                        user_sessions[token] = UserSession(token=token, username=username)
                        return username
                    else:
                        print(f"[AUTH] API returned error message: {data.get('message')}")
                        
                        # Если ошибка аутентификации, пробуем перелогиниться
                        if data.get("message") in ["authentication_failed", "user_not_found"]:
                            print("[AUTH] Session may be expired, trying to re-login...")
                            if await create_server_session():
                                print("[AUTH] Re-login successful, retrying token authentication")
                                # Повторяем запрос с обновленной сессией
                                return await authenticate_token(token)
                except json.JSONDecodeError as e:
                    print(f"[AUTH] Failed to parse response JSON: {e}")
                    return None
            else:
                print(f"[AUTH] HTTP error: {response.status}")
                # Если 401, пробуем перелогиниться
                if response.status == 401:
                    print("[AUTH] Session expired (401), re-logging in...")
                    if await create_server_session():
                        print("[AUTH] Re-login successful, retrying token authentication")
                        # Повторяем запрос с обновленной сессией
                        return await authenticate_token(token)
                return None
    
    except asyncio.TimeoutError:
        print("[AUTH] Request timeout")
    except Exception as e:
        print(f"[AUTH] Authentication error: {e}")
    
    return None

async def handler(websocket, path):
    """Обработчик WebSocket соединений"""
    # Разбор query-string для получения токена
    query = urlparse(path).query
    params = parse_qs(query)
    token = params.get("token", [""])[0]

    print(f"[WS] New WebSocket connection")
    print(f"[WS] Path: {path}")
    print(f"[WS] Token from query: {token}")

    # Аутентификация пользователя
    username = await authenticate_token(token)
    if not username:
        # Отправляем ошибку и закрываем соединение
        error_response = json.dumps({
            "error": "Invalid or expired token",
            "errorName": "SecurityError"
        })
        print(f"[WS] Authentication failed, sending error response")
        await websocket.send(error_response)
        await websocket.close()
        return

    print(f"[WS] User {username} connected successfully")
    
    # Основной цикл обработки сообщений
    async for message in websocket:
        print(f"[WS] Received message from {username}: {message}")
        
        try:
            data = json.loads(message)
            
            # Обработка keepalive сообщений
            if data.get("type") == "keepalive":
                print(f"[WS] Received keepalive from {username}")
                # Отправляем keepalive ответ
                keepalive_response = {
                    "type": "keepalive_response",
                    "timestamp": data.get("timestamp"),
                    "server_time": int(datetime.now().timestamp() * 1000)
                }
                await websocket.send(json.dumps(keepalive_response))
                continue
            
            request_id = data.get("id")
            op = data.get("op")
            storage_key = data.get("key")
            value = data.get("value")
            
            print(f"[WS] Parsed data: id={request_id}, op={op}, storage_key={storage_key}")
            
            if not request_id:
                print(f"[WS] No request ID, ignoring message")
                continue

            # Валидация операции
            if op not in ["put", "get", "delete"]:
                response = {
                    "id": request_id,
                    "error": f"Unknown operation: {op}",
                    "errorName": "DataError"
                }
                print(f"[WS] Invalid operation: {op}")
                await websocket.send(json.dumps(response))
                continue

            # Проверяем, активна ли еще сессия пользователя
            if token not in user_sessions:
                # Токен больше не действителен
                response = {
                    "id": request_id,
                    "error": "Session expired, please reload",
                    "errorName": "SecurityError"
                }
                print(f"[WS] Session expired for token: {token}")
                await websocket.send(json.dumps(response))
                await websocket.close()
                return

            # Выполнение операции
            if op == "put":
                if value is None:
                    response = {
                        "id": request_id,
                        "error": "No value provided for put",
                        "errorName": "DataError"
                    }
                    print(f"[WS] No value provided for put operation")
                else:
                    # Сохраняем как JSON строку
                    value_str = json.dumps(value)
                    success = await set_user_storage(username, storage_key, value_str)
                    if success:
                        response = {"id": request_id, "result": storage_key}
                        print(f"[WS] Put operation successful for {username}, storage_key: {storage_key}")
                    else:
                        response = {
                            "id": request_id,
                            "error": "Database write failed",
                            "errorName": "UnknownError"
                        }
                        print(f"[WS] Put operation failed for {username}, storage_key: {storage_key}")

            elif op == "get":
                value_str = await get_user_storage(username, storage_key)
                if value_str is not None:
                    # Возвращаем уже распаршенный JSON
                    try:
                        value_obj = json.loads(value_str)
                        response = {"id": request_id, "result": value_obj}
                        print(f"[WS] Get operation successful for {username}, storage_key: {storage_key}")
                    except:
                        response = {
                            "id": request_id,
                            "error": "Data corruption",
                            "errorName": "DataError"
                        }
                        print(f"[WS] Data corruption for {username}, storage_key: {storage_key}")
                else:
                    # Возвращаем null для несуществующих ключей (как IndexedDB)
                    response = {"id": request_id, "result": None}
                    print(f"[WS] Get operation returned null for {username}, storage_key: {storage_key}")

            elif op == "delete":
                success = await delete_user_storage(username, storage_key)
                if success:
                    # IDB delete возвращает undefined, но мы вернем null для совместимости
                    response = {"id": request_id, "result": None}
                    print(f"[WS] Delete operation successful for {username}, storage_key: {storage_key}")
                else:
                    response = {
                        "id": request_id,
                        "error": "Delete operation failed",
                        "errorName": "UnknownError"
                    }
                    print(f"[WS] Delete operation failed for {username}, storage_key: {storage_key}")

            # Отправляем ответ
            print(f"[WS] Sending response")
            await websocket.send(json.dumps(response))

        except json.JSONDecodeError as e:
            response = {
                "id": data.get("id", 0) if isinstance(data, dict) else 0,
                "error": "Invalid JSON",
                "errorName": "SyntaxError"
            }
            print(f"[WS] JSON decode error: {e}")
            await websocket.send(json.dumps(response))
        except Exception as e:
            print(f"[WS] Unexpected error: {e}")
            response = {
                "id": data.get("id", 0) if isinstance(data, dict) else 0,
                "error": str(e),
                "errorName": "UnknownError"
            }
            await websocket.send(json.dumps(response))

async def periodic_session_refresh():
    """Периодическое обновление серверной сессии"""
    while True:
        await asyncio.sleep(1800)  # Обновляем каждые 30 минут
        
        try:
            print("[SERVER] Periodic session refresh...")
            await create_server_session()
        except Exception as e:
            print(f"[SERVER] Failed to refresh session: {e}")

async def cleanup_session():
    """Очистка неактивных пользовательских сессий"""
    while True:
        await asyncio.sleep(300)  # Проверяем каждые 5 минут
        
        try:
            # Удаляем сессии старше 1 часа (можно добавить timestamp в будущем)
            current_time = datetime.now()
            expired_tokens = []
            
            # Пока просто логируем количество активных сессий
            print(f"[CLEANUP] Active user sessions: {len(user_sessions)}")
            if user_sessions:
                print(f"[CLEANUP] Users: {[session.username for session in user_sessions.values()]}")
        except Exception as e:
            print(f"[CLEANUP] Error: {e}")

async def database_health_check():
    """Проверка состояния базы данных"""
    while True:
        await asyncio.sleep(600)  # Проверяем каждые 10 минут
        
        try:
            if mysql_pool:
                async with mysql_pool.acquire() as conn:
                    async with conn.cursor() as cursor:
                        await cursor.execute("SELECT 1")
                        result = await cursor.fetchone()
                        if result and result[0] == 1:
                            print(f"[DB] Health check: OK")
                        else:
                            print(f"[DB] Health check: FAILED")
        except Exception as e:
            print(f"[DB] Health check error: {e}")

async def main():
    """Основная функция сервера"""
    print("[APP] Remote Storage Server starting...")
    print(f"[APP] MySQL config: host={MYSQL_CONFIG['host']}, db={MYSQL_CONFIG['db']}, user={MYSQL_CONFIG['user']}")
    print(f"[APP] Username: {USERNAME}")
    print(f"[APP] Auth API: {AUTH_API_URL}")
    print(f"[APP] Uinfo API: {UINFO_API_URL}")
    
    # Создаем SSL контекст
    ssl_context = create_ssl_context()
    if ssl_context:
        print(f"[APP] SSL enabled, using secure WebSocket (wss://)")
    else:
        print(f"[APP] SSL disabled, using plain WebSocket (ws://)")
    
    # Создаем пул соединений MySQL
    print("[APP] Creating MySQL connection pool...")
    if not await create_mysql_pool():
        print("[ERROR] Failed to create MySQL pool. Check database connection.")
        return
    
    # Инициализируем базу данных
    print("[APP] Initializing MySQL database...")
    try:
        await init_database()
    except Exception as e:
        print(f"[APP] Failed to initialize database: {e}")
        await close_mysql_pool()
        return
    
    # Создаем серверную сессию с аутентификацией
    print("[APP] Initializing server session...")
    if not await create_server_session():
        print("[ERROR] Failed to initialize server session. Check credentials.")
        await close_mysql_pool()
        return
    
    protocol = "wss" if ssl_context else "ws"
    print(f"[APP] Remote Storage Server started on {protocol}://0.0.0.0:16666")
    print(f"[APP] Keepalive interval: 30 seconds")
    
    # Запускаем фоновые задачи
    refresh_task = asyncio.create_task(periodic_session_refresh())
    cleanup_task = asyncio.create_task(cleanup_session())
    health_task = asyncio.create_task(database_health_check())
    
    try:
        # Настраиваем WebSocket сервер с SSL если нужно
        async with websockets.serve(
            handler, 
            "0.0.0.0", 
            16666,
            ssl=ssl_context,
            ping_interval=20,
            ping_timeout=40,
            close_timeout=10,
            max_size=10 * 1024 * 1024,  # 10MB
            compression=None
        ):
            print("[APP] WebSocket server is running...")
            await asyncio.Future()  # Бесконечный цикл
    except KeyboardInterrupt:
        print("\n[APP] Server stopped by user")
    except Exception as e:
        print(f"[APP] Fatal error: {e}")
    finally:
        # Отменяем фоновые задачи
        refresh_task.cancel()
        cleanup_task.cancel()
        health_task.cancel()
        
        # Закрываем серверную сессию
        if server_session and not server_session.closed:
            await server_session.close()
        
        # Закрываем пул MySQL
        await close_mysql_pool()
        
        # Очищаем кэш пользовательских сессий
        user_sessions.clear()
        print("[APP] Cleanup completed")

if __name__ == "__main__":
    print("[APP] Starting Remote Storage Server...")
    
    # Можно также принимать параметры из командной строки
    import argparse
    parser = argparse.ArgumentParser(description="Remote Storage WebSocket Server")
    parser.add_argument("--ssl", action="store_true", help="Enable SSL")
    parser.add_argument("--cert", type=str, help="SSL certificate path")
    parser.add_argument("--key", type=str, help="SSL private key path")
    args = parser.parse_args()
    
    # Обновляем конфигурацию SSL из аргументов командной строки
    if args.ssl:
        USE_SSL = True
    if args.cert:
        SSL_CERT_PATH = args.cert
    if args.key:
        SSL_KEY_PATH = args.key
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[APP] Server stopped by user")
    except Exception as e:
        print(f"[APP] Fatal error: {e}")
