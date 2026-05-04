# Connection flow diagrams (draft)

Internal reference: BLE discovery / Wi-Fi setup and remote WebRTC session (including `RobotAppLock`). Edit freely.

---

## 1. Bluetooth – discovery, IP, and Wi-Fi setup (unified)

Single flow: scan → robot seen from the advert (TLV) → either read IP when already on Wi-Fi, or open the provisioning sequence (PIN, scan, connect, probe).

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#ddeeff', 'primaryTextColor': '#111', 'primaryBorderColor': '#4466aa', 'lineColor': '#4466aa', 'secondaryColor': '#cceecc', 'tertiaryColor': '#ffe8cc'}}}%%
graph TB
    A[Scan BLE] --> R[Robot détecté advert TLV]
    R -->|network_mode = connected| N[NETWORK_STATUS si besoin]
    R -->|hotspot / offline / TLV absent| S1[Écran setup Wi-Fi]

    N --> IP[IP + port HTTP ou WebRTC]

    S1 --> S2[Write PIN_xxx + read RESPONSE]
    S2 -->|erreur| S2
    S2 -->|OK| S3[Write WIFI_SCAN + read RESPONSE]
    S3 --> S4[Choix SSID + PSK]
    S4 --> S5[Write WIFI_CONNECT ssid:psk]
    S5 --> S6[Boucle WIFI_STATUS rapide]
    S6 -->|wlan + IP| S7[Write WIFI_PROBE]
    S6 -->|timeout| ERR[Erreur utilisateur]
    S7 -->|OK| OK[Fin BLE trafic sur IP]
    S7 -->|diagnostic| RETRY[Message + retry]
    RETRY --> S4

    classDef n fill:#ddeeff,stroke:#4466aa,color:#111
    classDef ok fill:#cceecc,stroke:#448844,color:#111
    classDef bad fill:#ffdddd,stroke:#cc4444,color:#111
    classDef warn fill:#ffe8cc,stroke:#cc8833,color:#111
    class A,R,N,S1,S2,S3,S4,S5,S6,S7 n
    class IP,OK ok
    class ERR bad
    class RETRY warn
```

---

## 2. WebRTC – connection sequence (central relay + RobotAppLock)

```mermaid
sequenceDiagram
    autonumber
    participant App as App mobile SDK
    participant Central as Centrale HF
    participant Relay as central_signaling_relay
    participant Lock as RobotAppLock
    participant Gst as GStreamer webrtcbin
    participant API as Uvicorn daemon HTTP

    Note over Relay,Lock: Au boot du daemon : Lock = free, relay enregistré producteur sur la centrale

    App->>Central: startSession peerId robot
    Central->>Relay: startSession + sessionId

    alt Session pending ou active (filet relay)
        Relay->>Central: endSession reason robot_busy_local
        Central-->>App: session refusée ou coupée
    else Pas de session concurrente côté relay
        Relay->>Lock: try_acquire_remote remote
        alt Lock refuse (ex. appli Python locale)
            Lock-->>Relay: false
            Relay->>Central: endSession reason robot_busy_local_app
            Central-->>App: fin de session côté client
        else Lock free → remote_session
            Lock-->>Relay: true
            Relay->>Gst: list puis startSession local
            Gst-->>Relay: session locale, ids mappés central ↔ local

            par SDP et ICE via la centrale
                Gst->>Relay->>Central->>App: offer
                App->>Central->>Relay->>Gst: answer
                App->>Central->>Relay->>Gst: ICE client
                Gst->>Relay->>Central->>App: ICE robot
            end

            Note over App,Gst: ICE connected, DTLS, DataChannel

            App->>Gst: trafic http_proxy sur DataChannel
            Gst->>API: requêtes HTTP vers 127.0.0.1
            API-->>Gst: réponses
            Gst-->>App: réponses encapsulées

            App->>Central: endSession
            Central->>Relay: endSession
            Relay->>Gst: endSession local
            Relay->>Lock: release_remote si plus aucune session
            Lock-->>Lock: état free
        end
    end
```

---

## 3. WebRTC – overview (directed graph, top-down)

```mermaid
graph TB
    A[App : startSession sur la centrale] --> B[Relais : session déjà ouverte ?]
    B -->|oui| R1[Refus robot_busy_local]
    B -->|non| C[RobotAppLock try_acquire_remote]
    C -->|refus appli locale| R2[Refus robot_busy_local_app]
    C -->|ok remote_session| D[GStreamer : négociation WebRTC]
    D --> E[DataChannel ouvert]
    E --> F[http_proxy vers Uvicorn]
    F --> G[Fin : endSession]
    G --> H[RobotAppLock release_remote]

    classDef step fill:#ddeeff,stroke:#4466aa,color:#111
    classDef rej fill:#ffdddd,stroke:#cc4444,color:#111
    classDef done fill:#cceecc,stroke:#448844,color:#111
    class A,B,C,D,E,F,G step
    class H done
    class R1,R2 rej
```

---

## 4. Centrale HF – vue lisible (signaling)

Une seule idée : **SSE pour recevoir**, **POST pour envoyer**. Pas de WebSocket dans ce service : tout passe par `/events` + `/send`.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#ddeeff', 'primaryTextColor': '#111', 'primaryBorderColor': '#4466aa', 'lineColor': '#4466aa', 'secondaryColor': '#cceecc', 'tertiaryColor': '#ffe8cc'}}}%%
flowchart TB
    subgraph ext["Internet"]
        HF["HF api/whoami-v2<br/>valide le Bearer token"]
    end

    subgraph cli["Clients même compte HF"]
        R["Robot / tray<br/>producteur"]
        U["App mobile, web, desktop<br/>consommateur"]
    end

    subgraph cen["Centrale FastAPI"]
        EV["GET /events<br/>flux SSE entrant"]
        PS["POST /send<br/>JSON sortant"]
        ST["État : peers, producers, sessions<br/>relai SDP / ICE"]
        SW["Sweeper TTL<br/>lease + last_seen"]
    end

    API["GET /api/robot-status<br/>busy / meta sans ouvrir session"]

    HF -.->|token| EV
    HF -.->|token| PS
    HF -.->|token| API

    R --> EV
    U --> EV
    R --> PS
    U --> PS

    EV --> ST
    PS --> ST
    SW --> ST

    U --> API

    R <-.->|messages relayés via ST| U

    classDef hf fill:#f0f0f0,stroke:#666,color:#111
    classDef peer fill:#ddeeff,stroke:#4466aa,color:#111
    classDef core fill:#ffe8cc,stroke:#cc8833,color:#111
    classDef side fill:#e8f5e9,stroke:#448844,color:#111
    class HF hf
    class R,U peer
    class EV,PS,ST,SW core
    class API side
```

**Ordre typique**

1. Ouvrir **`/events`** → la centrale envoie `welcome` (peerId, lease, heartbeat conseillé) puis la **liste des robots** du user.
2. Trafic temps réel : **`/send`** (`setPeerStatus`, heartbeat, `startSession`, SDP/ICE, `endSession`).
3. **`/api/robot-status`** : lecture seule pour l’UI (occupé, app active, fraîcheur).