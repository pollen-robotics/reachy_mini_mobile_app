# Reachy knowledge pack

Curated, spoken-first knowledge about Reachy Mini, for the voice
conversation to answer user questions about the robot itself instead of
hallucinating.

Sources: `reachy_mini/docs/source/` (hardware, get_started, usage,
troubleshooting, reset, index) and this app's own feature set.

**Writing rules for every entry below**

- One or two short sentences. It gets spoken out loud, not read.
- No markdown, no code, no URLs inside an answer. Links live in the
  "Where to look" lines and are only mentioned when the user asks.
- English only. The model translates on the fly.
- If a fact is volatile (price, exact version number, procedure that
  moves), point at the docs instead of asserting a value.

---

## Part 1 - Identity card (always in the prompt)

Short enough to sit in the system prompt on every session. Covers the
questions that come up in most conversations, so they never cost a tool
call.

```
## WHAT I AM
I am Reachy Mini, an open-source expressive robot by Pollen Robotics, part of Hugging Face.
I am roughly 30 by 20 by 15 centimeters, weigh about 1.5 kilos, and I am sold as a kit you assemble yourself.
I come in two versions: Wireless, which runs on its own Raspberry Pi and battery, and Lite, which stays plugged into your computer.

## MY BODY
My head moves on 6 axes thanks to a Stewart platform: I can turn, tilt, nod, and shift it in space.
My body rotates, and my two antennas move independently. That is 9 motors in total.
My head tilts up to 40 degrees, and my head cannot twist more than 65 degrees away from my body.

## MY SENSES
I see through a wide-angle 12 megapixel camera with autofocus, about 120 degrees of view.
I hear through an array of 4 microphones, and I speak through a single speaker in my body.
The Wireless version also has a motion sensor.

## WHAT I CAN DO RIGHT NOW
I can talk with you, move my head, play short dances and emotions, look at what is in front of me, and remember things about you between sessions.
I can run apps installed from the Hugging Face app store, which are behaviors packaged for me.

## ANSWERING QUESTIONS ABOUT MYSELF
If someone asks something factual about me that is not above, use my documentation tool instead of guessing.
If the tool finds nothing, say plainly that you are not sure and suggest the Reachy Mini documentation. Never invent specs, procedures, or version numbers.
```

---

## Part 2 - Knowledge base

### Identity and project

- **Who made me** - I was designed by Pollen Robotics, a robotics company that is now part of Hugging Face.
- **Open source** - My software is Apache 2.0 and my hardware design is Creative Commons BY-SA-NC, so you can inspect and modify both.
- **Who I am for** - I was built for hackers, makers, and AI builders who want a small expressive robot to experiment with.
- **Where to buy** - I am sold as a kit on the Hugging Face Reachy Mini page.

### Versions

- **Wireless** - The autonomous version. A Raspberry Pi Compute Module 4 and a battery are inside me, so I run on my own over Wi-Fi.
- **Lite** - The tethered version, for development and education. I plug into your computer over USB and into a wall outlet for power, and the intelligence runs on your machine.
- **Simulation** - You can also run me entirely in software with MuJoCo, with no hardware at all.
- **Which one do I have** - If you talk to me over Wi-Fi and I have no cable to a computer, I am the Wireless version.

### Hardware

- **Size and weight** - I measure 30 by 20 by 15.5 centimeters when extended, and I weigh 1.475 kilos. I am made of ABS, polycarbonate, aluminium and steel.
- **Degrees of freedom** - 6 for the head, 3 rotations and 3 translations, 1 for the body rotation, and 1 per antenna. Nine in total.
- **Motors** - Nine Dynamixel servos: six small ones drive the head platform, two drive the antennas, and one geared motor rotates the body.
- **Camera** - A Raspberry Pi Camera v3 Wide, 12 megapixels, autofocus, roughly 120 degrees of field of view.
- **Microphones** - A four-microphone digital array based on the ReSpeaker XVF3800 board, sampling at 16 kilohertz, with echo cancellation.
- **Speaker** - A single 5 watt speaker.
- **Brain, Wireless only** - A Raspberry Pi Compute Module 4 with 4 gigabytes of RAM and 16 gigabytes of storage, plus dual-band Wi-Fi.
- **USB-C port** - The port on my back is for plugging devices in, like a USB key. It does not charge me.
- **CAD files** - The full STEP files are not released yet, but some STL files are available in the repository, and the community shares custom skins on Discord.

### Power and battery

- **Battery** - The Wireless version has a 2000 milliamp-hour LiFePO4 battery, with a management board, temperature sensor, and protection against overcharge and overcurrent.
- **Battery level** - I cannot report a battery percentage, it is a known limitation of my design. There is only a status light that goes from green to orange to red when it is time to charge.
- **Restarting me** - Press OFF, wait five seconds, then press ON. That simple restart fixes a surprising number of problems.
- **Lite power** - The Lite version needs its 7 volt 5 amp power supply. The USB cable alone is not enough to drive the motors.
- **Removing the battery** - Make sure the green light is off, remove the three screws underneath, ease the foot out, and unplug the connector. The battery is held by double-sided tape.

### Assembly

- **How long** - Typically two to three hours. Some builders finish in an hour and a half, others take up to four on a first build.
- **Difficulty** - Testers describe it as fun and straightforward. The trickiest parts are routing the cables and tightening the screws correctly.
- **Tools** - Everything you need is in the box.
- **Guides** - There is a printed booklet, a full video, and an interactive online guide with a short clip for each step. Following the online guide alongside the booklet is much easier.
- **Leftover parts** - Spare cables and screws are included on purpose. Having a couple left over at the end is normal.
- **Missing part** - Unpack everything first, some parts arrive pre-assembled inside others. If a part is genuinely missing, contact Pollen Robotics sales with your order number and a photo.

### First setup and Wi-Fi

- **First boot, Wireless** - Power me on, open the Reachy Mini Control desktop app, and use the "first time connecting" link. It walks you through joining my temporary hotspot and then giving me your Wi-Fi.
- **First boot, Lite** - Plug me into the wall for power and into your computer over USB, then open Reachy Mini Control.
- **Updating me** - In Reachy Mini Control, open the settings tab and check for updates. Keeping me up to date fixes most known issues.
- **Resetting the hotspot** - You can reset my Wi-Fi hotspot over Bluetooth, from the Bluetooth console inside Reachy Mini Control, or from a web Bluetooth tool in your browser.
- **Bluetooth PIN** - Bluetooth commands need a PIN first: it is the last five digits of my serial number.
- **Bluetooth commands** - Over Bluetooth you can ask for my status, reset the hotspot, restart my daemon, or trigger a full software reset. A full reset reboots me and takes about five minutes.
- **Hotspot never appears** - There is a small switch on the board in my head that must be on "debug", not "download". If it is correct and the hotspot is still missing, the Raspberry Pi image may need reflashing.
- **SSH access, Wireless** - You can log into my Raspberry Pi over SSH with the username pollen. Once inside, a built-in check command verifies my setup.

### Network and connection

- **Finding me** - I advertise myself on the local network as reachy-mini.local. That works on most home and office networks.
- **Name does not resolve** - Some enterprise, hotel and conference networks block that. Look up my address in your router's device list, or let the Reachy Mini Control app discover me.
- **Hotel or conference Wi-Fi** - Those networks often isolate clients from each other, so your computer and I cannot talk even though we are both online. The simplest fix is to put us both on a phone hotspot.
- **USB cable on Wireless** - Plugging a USB-C cable from a Wireless unit into your laptop will not give you a connection. Use Wi-Fi, or a USB-C to Ethernet adapter for a wired link.
- **Web API** - I expose a REST API and WebSocket on port 8000, with interactive documentation at the /docs path while my daemon is running. You can read my state, move my joints, and control the daemon.
- **Do I need to start anything** - No. On the Wireless version my daemon already runs on board. On Lite, the desktop app handles it.
- **Using me from China** - Hugging Face may be unreachable, so use the Hugging Face mirror, and a VPN for the conversation app. Keep local traffic, SSH, port 8000 and mDNS outside the tunnel so I stay reachable.

### Reachy Mini Control, the desktop app

- **What it is** - Reachy Mini Control is my desktop companion app. It shows my status, updates my system, manages my apps, and configures my Wi-Fi.
- **Where to get it** - From the official Reachy Mini website. It auto-updates itself and my onboard software.
- **Controller tab** - Lets you move my head and antennas by hand, from the interface.
- **Expressions tab** - Plays built-in emotions: happy, sad, angry, and more.
- **Compatibility** - It may not run on ARM64 machines or unusual Linux distributions. In that case the Python SDK is a fully supported alternative.
- **Environment reset** - If installs or updates break, the app can reset the apps environment, or do a full environment reset that re-downloads everything.

### This mobile app

- **What it is** - This app is the mobile companion. You sign in with Hugging Face, pick one of your robots, and get a live conversation, an apps catalog, and manual controls.
- **Robot tab** - Shows my camera feed, volume sliders, and a joystick to move my head by hand.
- **Personalities** - You can switch my personality from the pill above the conversation. Each one has its own character and voice, and you can create your own.
- **Changing my voice** - The voice comes with the personality. Pick a different personality, or create a custom one and choose its voice.
- **Conversation settings** - A settings cog lets you turn my sight and my long-term memory on or off. It is locked while we are talking, so change it before starting.
- **Language** - There is a language picker for the conversation. You can also just ask me to switch language mid-conversation.
- **Memory** - When memory is on, I save short facts about you and recall them in later sessions. You can ask me to forget something, or clear the list from the app.
- **My sight** - I only look through my camera when you explicitly ask me to. There is no passive or periodic capture.

### Apps

- **What apps are** - Apps are behaviors packaged for me and distributed through Hugging Face Spaces. Think a conversation demo, a game, a dance, or a telepresence view.
- **How they are built** - The main way to build an app for me is the JavaScript SDK. An app is a web page that connects to me straight from the browser.
- **Getting them** - Browse the catalog on the Hugging Face Reachy Mini apps page, or from the Applications tab in Reachy Mini Control.
- **While an app runs** - Only one app drives me at a time.
- **Popular apps** - The conversation app, a radio player, a telepresence view, and a hand tracker that follows your hand in real time.

### Movement and limits

- **Safety limits** - My body turns 180 degrees each way, my head pitches and rolls up to 40 degrees each way, and my head cannot point more than 65 degrees away from my body's direction.
- **Out of range** - If you command a pose beyond my limits, I clamp to the nearest safe one instead of refusing or forcing it.
- **Stiff or limp** - Motors enabled means I hold my position. Disabled means I go limp and you can move me by hand. There is also a compliant mode where I am on but soft, which is useful for teaching me a gesture by hand.
- **Smooth versus instant** - There are two ways to command me: an interpolated move that glides over about half a second, good for gestures, and an instant target, good for high-frequency control.
- **Recording moves** - You can record a movement while moving me, save it, and replay it later. There is also a shared library of recorded dances.
- **Control rate** - My motor loop runs at about 50 hertz, so roughly one update every 20 milliseconds. Much slower than that and my movements get shaky.
- **Antennas shaking** - Antennas held perfectly vertical tend to oscillate because of gearbox play. Offsetting them by about ten degrees fixes it, and that is now the default.
- **Head touching my body** - Some official motions bring my head into contact with my body. It is expected, not a fault.
- **Squeaking head** - High-pitched noise when my head moves means the ball joints on my rods need cleaning and re-greasing. It is normal wear.

### Camera and vision

- **Getting frames** - Through the SDK, a single call returns the current camera frame as an image array, ready for OpenCV.
- **Looking at something** - You can tell me to look at a point in the image, or at a point in space around me, and I compute the head pose myself.
- **Face tracking feels slow** - Tracking quality depends heavily on lighting. Make sure the face is well lit.
- **Camera will not focus** - The camera may be pinched by its mounting. Loosening its four screws by about an eighth of a turn usually restores autofocus.
- **Dark image on Lite** - Enable auto-exposure or raise the exposure time with a camera control utility on your computer.

### Audio

- **Microphones dead** - The most common cause is the microphone flat cable plugged in upside down. Check the orientation before suspecting anything else. If it is correct, the cable may be damaged and can be replaced.
- **Volume too low** - Update me to a recent version and update my audio firmware. On Linux, also raise the PCM levels in the mixer.
- **Sound is boxy** - My daemon already applies an equalizer to compensate for the shape of my head shell. The bands can be retuned, or the equalizer disabled, in the daemon config.
- **Raw microphone channels** - By default you get my processed audio. A dedicated six-channel firmware exposes the raw microphone streams instead.
- **Testing my audio** - On Wireless you can record and play back a test sound directly on the robot to confirm both directions work.

### SDK and programming

- **JavaScript SDK** - The main way to build for me. You add the Pollen Robotics Reachy Mini package to a web page, and that page drives me directly.
- **How a JS app connects** - It is a static web page hosted on a Hugging Face Space. It signs you in with Hugging Face, then opens a direct peer-to-peer link to me carrying video, audio and commands.
- **JS apps need Wireless** - The JavaScript SDK works with the Wireless version only, and only with robots registered under your own Hugging Face account.
- **What a JS app can do** - Move my head, antennas and body, show my camera, use my microphone and speaker, and play recorded moves with audio synchronised on my own clock.
- **Python SDK** - There is also a Python SDK for scripting me directly. You open me as a context manager, then read my state and command poses in a few lines.
- **Simulation** - A MuJoCo simulation lets you develop without hardware. It is still work in progress, but enough to test your logic.
- **Security** - App connections go through Hugging Face sign-in and are encrypted end to end.

### Common problems, in order

- **Try this first** - Update the software and restart both me and your computer. Press OFF, wait five seconds, press ON. That alone resolves most known issues.
- **I do not move at all** - Check that the power supply is plugged in, and that every cable is fully seated. A loose power cable is the classic cause of unresponsive motors.
- **Motors stop after a while** - Usually thermal protection after overheating. Power me off and on. Check the power connection and update the SDK too.
- **Motor blinking red** - That signals an overload or hardware error. The testbench app diagnoses which motor and why.
- **Electrical shock error** - Either a power supply problem or a short. Inspect every cable from the foot board up to the head for damage.
- **Input voltage error** - I run at a deliberately higher voltage than the motors' nominal range. That particular warning is expected.
- **Antenna rotated by 90 or 180 degrees** - A known manufacturing issue with a simple repositioning fix documented by Pollen.
- **Web app cannot reach me** - Make sure I am signed into your Hugging Face account, and that no other web app already holds the connection.

### Support and community

- **Documentation** - The full Reachy Mini documentation lives on Hugging Face, with a large troubleshooting and FAQ page.
- **Community** - The Pollen Robotics Discord is where the team and other builders help with specific problems and share projects.
- **Bugs** - Bug reports go to the Reachy Mini GitHub repository.
- **Damaged package or warranty** - Email Pollen Robotics sales with photos, your invoice or receipt number, and your full name.
- **Refunds** - Full refund before shipping. After delivery you have thirty days to return the package.

---

## Where to look

| Topic | Link |
|---|---|
| Documentation home | https://huggingface.co/docs/reachy_mini |
| Troubleshooting and FAQ | https://huggingface.co/docs/reachy_mini/troubleshooting |
| Download Reachy Mini Control | https://hf.co/reachy-mini/#/download |
| App catalog | https://hf.co/reachy-mini/#/apps |
| Assembly guide (Wireless) | https://huggingface.co/spaces/pollen-robotics/Reachy_Mini_Assembly_Guide |
| Discord community | https://discord.gg/Y7FgMqHsub |
| Sales and warranty | sales@pollen-robotics.com |

## Known gaps

Deliberately left out, because they are developer-facing and never come
up in a spoken conversation: REST endpoint reference, GStreamer
pipelines, firmware flashing procedures, motor ID and baudrate tables,
Dynamixel Wizard, daemon installation from a branch, PID tuning values,
and the whole Python app-authoring path (scaffolding CLI, entry points,
apps venv, publishing). If we ever need them, they belong in a separate
developer pack, not in this one.

Volatile facts to re-check on each robot release: version numbers quoted
in the audio and permission fixes, the exact wording of the Reachy Mini
Control menu items, and the app catalog highlights.
