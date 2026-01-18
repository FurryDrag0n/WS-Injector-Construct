/**
 * RemoteStorage Injector
 * ----------------------
 * Перехватывает IndexedDB до загрузки Construct‑runtime и
 * перенаправляет операции put/get/delete на WebSocket‑сервер.
 * Токен авторизации берётся из URL (?token=...).
 *
 * Подключать строго перед main.js и другими скриптами Construct.
 */

const REMOTE_ADDRESS = '127.0.0.1'; // Адрес WebSocket-сервера, доступный из внешней сети (localhost подходит только для отладки)
const LISTENING_PORT = 16666; // Прослушивающий порт (не забудьте открыть)

const urlParams = new URLSearchParams(window.location.search);
const AUTH_TOKEN = urlParams.get("token");

console.log("Token from URL:", AUTH_TOKEN);

window.gameSocket = new WebSocket(`ws://${REMOTE_ADDRESS}:${LISTENING_PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`);

gameSocket.addEventListener("open", () => {
    console.log("[WS] Connected with token:", AUTH_TOKEN);
});

gameSocket.addEventListener("error", (err) => {
    console.error("[WS] Error:", err);
});

(function() {

    function emulateResult(result = undefined) {
        const req = {};
        setTimeout(() => {
            if (req.onsuccess) req.onsuccess({ target: { result } });
        }, 0);
        return req;
    }

    IDBObjectStore.prototype.put = function(value, key) {
        if (window.gameSocket?.readyState === WebSocket.OPEN) {
            window.gameSocket.send(JSON.stringify({
                op: "put",
                key,
                value
            }));
        }
        return emulateResult();
    };

    IDBObjectStore.prototype.get = function(key) {
        if (window.gameSocket?.readyState === WebSocket.OPEN) {
            window.gameSocket.send(JSON.stringify({
                op: "get",
                key
            }));
        }
        return emulateResult(null);
    };

    IDBObjectStore.prototype.delete = function(key) {
        if (window.gameSocket?.readyState === WebSocket.OPEN) {
            window.gameSocket.send(JSON.stringify({
                op: "delete",
                key
            }));
        }
        return emulateResult();
    };

})();
