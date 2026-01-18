### Using the Injector

1. Copy `ws_injector.js` (you'll find it in `frontend/` folder) into the `scripts/` directory of your game build.

2. Open your HTML file and include the injector **before any Construct scripts**:

    <script src="scripts/ws-injector.js"></script>
    <!-- other eventual files -->
    <script src="scripts/modernjscheck.js"></script>
    <script src="scripts/supportcheck.js"></script>
    <script src="scripts/main.js" type="module"></script>

3. Launch the game with a token in the URL:

    https://example.com/game/?token=MYTOKEN123

The injector will automatically:
- read the token from the URL
- open a WebSocket connection
- override IndexedDB operations and forward them to the server
