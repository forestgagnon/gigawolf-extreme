# Decisions

Ambiguities in the plan, resolved with the simplest option.

## Milestone 1 (engine)

- **Package.json**: added with `"type": "module"` so `node --test tests/` treats `.js` as ESM. No dependencies. GitHub Pages ignores it.
- **RNG**: `js/util/rng.js` (mulberry32) is not in the plan's file list; it provides a seedable RNG whose state can be saved for host resume.
- **Action shape**: `{ kind, by, now, ...payload, nonce? }`. The engine never reads the clock and has no timers: the host advances every phase.
- **Effects**: `{type:'views'}` (host should recompute `viewFor` for every player and send), `{type:'narrate', text}`, `{type:'haptic'}`. The engine returns the view *request*, not view bodies, so views are always built from the final state.
- **Errors**: a rejected action returns the unchanged state, no effects and `error: {code, message}`.
- **Night picks are final on confirm.** "Teammates' current picks show live" is implemented as: a wolf's confirmed pick is visible to other wolves immediately. No tentative/changeable picks.
- **Villager** `nightPick` ignores the target and just marks them submitted.
- **Who must submit**: every living player. Wolves/Seer/Bodyguard must give a valid target (no explicit "no pick"; timing out is how you pass).
- **Seer** cannot check themselves. Seer results from all nights are kept privately (`you.private.seerLog`).
- **Bodyguard restriction** resets if they skip a night (timeout) or die.
- **Night end**: the host ends the night (`nextPhase`) whenever they choose; players who haven't picked count as no pick. It never ends on its own, so the table can't tell who confirmed last.
- **Vote**: self-votes are not allowed; votes are final on confirm; a non-voter counts as Skip. Resolves immediately when everyone has voted. A tie, or Skip being among the top, = no elimination.
- **Vote result screen**: after resolution, the phase stays `vote` (stage `result`) with no timer until the host clicks Next, then night begins, or game over if someone won. After a *night* kill that ends the game, it goes straight to game over.
- **Dead players**: no prompt, no actions. They keep seeing their own role. The "dead" screen is chosen by `you.alive`, not a separate phase.
- **A dead host can still advance the game** (start the vote, end night, Next), since nothing else would.
- **Role counts**: `settings.counts = null` means "auto preset for current player count"; the host overriding it sets explicit counts, validated at Start.
- **Join**: allowed in lobby only (max 15). Rejoin with the same player ID is allowed any time; names are locked once the game starts. Only non-host players can `leave`.
- **Views**: `viewFor(state, playerId, hostNow)`. `players[].role` is only filled for yourself, for dead players when `revealOnDeath` is on, and for everyone at game over. Wolves get teammates via `you.private.teammates`. Per-player "has submitted" is never shown to others (timing reveals nothing).
- **Nonce memory**: the last 50 nonces per player, kept inside engine state (so they survive host resume).

## Milestones 2–5

- **No `v` mismatch handling beyond an error**: a client with a different protocol version gets a `badVersion` error.
- **`playAgain`** was added to the client action kinds (the plan's list omitted it but "Play again" needs it).
- **Connection abstraction**: PeerJS is injected (`Peer` constructor) so tests run the real Host/Client over an in-memory fake (`js/dev/fakepeer.js`).
- **Initial join failure** shows the "Can't reach the host" message and stops. After the first successful join, or when auto-rejoining a saved session, the client retries forever (1s, 2s, 5s, then 5s) and shows "Host disconnected, waiting…".
- **Ping/pong**: clients ping every 5s; no message for 15s forces a fresh connection (frozen mobile sockets often never fire `close`).
- **Host resume**: state, RNG state and room code saved after every applied action. On resume all players start as disconnected. Same-ID registration retries for up to 60s.
- **Rejoin after reload** (non-host): a saved session auto-rejoins on page load, also when the URL has `?join=` for the same room.
- **Haptics** run client-side on every phone when its own phase/alive state changes (not as a host effect).
- **Narration and music** play on any phone, each with its own button in the tools row. Music defaults on and narration off for everyone (changed in v1.26.0; see "Fewer host options"); each phone can change either. The host's choice is remembered across games, a player's only for that room. The host sends the latest line with every view as `narration: { seq, text }` (the game's `narration` setting stays on and has no host switch); a phone speaks when `seq` changes, skipping the first view after it connects. Speech and audio still need a tap to start, so sound turned on without one starts on the next tap.
- **Bots** are real Clients on host loopback connections (`?bots=N`, max 14).
- **Idle players** don't stall anything: the host can advance past them (no pick / Skip / not ready).
- **Not tested here**: real iOS/Android phones, hotspot and client-isolation networks, speech synthesis and wake lock (verified only in headless Chrome and Node).

- **No timers at all** (casual same-room play). The host advances with one button per phase: Start night (reveal), Dawn (night), Start vote (day), End vote now (vote, optional: it also ends by itself once everyone has voted), Next (result). The host sees aggregate progress counts only (e.g. 3/5 confirmed), never who. Night/discussion/vote length settings were removed.

## Extra roles (Wolf Cub, Hunter, Witch, Prince, Diseased Villager, Jester)

- **Opt-in, any player count.** The auto preset is still the classic set (wolves, Seer, Bodyguard, villagers). The host can override it with the lobby steppers even at 5 players, as long as the setup is not game-breaking.
- **Game-breaking setups are rejected at Start** (`validate` in `setup.js`), because the outcome would be fixed before anyone can play:
  - no wolf-side player (instant village win), or wolves ≥ everyone else (instant wolf win);
  - wolves win after a single night kill (`2 × wolves ≥ players − 1`) and nothing reliable can stop it. A Witch counts as a reliable counter (she sees the victim and heals); a Bodyguard does not (she guesses). So 2 wolves in 5 players need a Witch;
  - nobody on the village side except Jesters (the first vote always elects a Jester);
  - a lone wolf against a village made only of Hunters (every shot kills someone, so the chain only ends when it hits the wolf).
  Setups that are merely lopsided but playable (e.g. many Witches, a lone wolf vs lots of Hunters plus other roles) are allowed. This was checked by playing random games on every valid setup at 5, 6 and 7 players (about 5,600 setups) and a sample at 8: no crashes, no non-terminating games, no guaranteed outcome left.
- **Nobody left to shoot**: if every player dies in the same night (e.g. poison, revenge kills and a hunter), the hunter's shot is dropped and the game ends (the wolves are dead, so the village wins).
- **Wolf Cub**: wolf team, shows as a wolf to the Seer, counts as a wolf for the win check. When it dies (night, vote, shot or poison) the wolves pick **two** different victims on the next night only (`night.doubleKill`). The two best-voted targets die, ties broken randomly.
- **Hunter**: dies → a new `shot` phase. The hunter picks one living player (`shoot`); the host can skip if the hunter is idle. Shots resolve before the win check, so a shot can end the game. A poisoned hunter still shoots. Chained shots (two hunters) are queued. Hunter shots reveal the hunter even with "reveal on death" off.
- **Witch**: one heal and one poison, each once, at most one potion per night (`heal:<id>` / `poison:<id>` / `pass`). She sees the wolf victims only after every living wolf has confirmed (otherwise she is told to wait). The heal only works on a current victim; potions are spent when confirmed. Poison deaths are announced like any night kill so nobody can tell them apart.
- **Prince**: the first vote against them fails, they are revealed to everyone (`revealed`), and nobody dies. After that they are an ordinary voteable player.
- **Jester**: own team (`jester`). Wins alone the moment they are voted out (announced after the result screen, like other wins). Dying at night does nothing. A living jester counts as a non-wolf for wolf parity, and loses when village or wolves win.
- **Diseased Villager** (v1.7.0; internal role id `diseased`, shown to players as "Diseased Villager"): village team, no night action, counts as a villager for parity. If the wolves night-kill them (not protected, not healed), `state.diseasedDied` is set and the *next* night is a sick night (`night.noKill`): wolves cannot kill anyone. Vote-out, Witch poison, Hunter shot, Bodyguard save and Witch heal do nothing. A Diseased who is both wolf-killed and poisoned still triggers it. Choices on ambiguous points:
  - **Sick night + Cub revenge night**: the skip wins and the revenge is consumed (not carried over to a later night). The Cub flag is cleared when the night starts either way.
  - **Wolves still confirm**: their prompt says they cannot kill tonight and the Confirm button works with no target (no pick needed), so the night counts them as done and the host can end it as usual. Wolf picks are ignored on that night even if sent. No public announcement: the dawn text is just "Nobody died." (or poison/shot deaths), so the village only infers it.
  - **Witch**: `night.victims` starts as `[]` on a sick night, so she is not told to wait and sees "nobody is targeted", never a phantom victim. Her poison works as normal.
  - **Win/parity and validate()**: Diseased is village side; no validate() rule changes. A lone Diseased does not count as a reliable counter to the first-night wolf win, so the existing "wolves win on night one" rule still needs a Witch.
  - Included in the secret random mix (20% chance, once).
- **Seer's Apprentice** (v1.8.0, id `apprentice`): village team, decoy prompt until promoted. Choices:
  - **Validation**: `validate()` rejects any pool with more Apprentices than Seers (one Seer per Apprentice) with the error "Seer's Apprentice needs a Seer...", shown in the lobby, and the Start button stays disabled. The lobby steppers also stop the host from creating it (Apprentice max = Seer count, Seer min = Apprentice count). The secret random mix is rejection-sampled through `validate()`, so it can never produce it.
  - **Promotion**: when a Seer dies by any cause, `state.promotions` is incremented; after the whole batch of deaths settles (before hunter shots, and after each shot) each pending promotion turns the first living Apprentice (seating order) into a Seer, 1:1. Seer and Apprentice dying in the same batch: no promotion. Apprentice dying first: nothing happens. No public announcement; the promoted player gets a private notice (`you.private.promoted`) and the Seer prompt from the next night.
  - **Fresh log**: Seer log entries are tagged with the Seer who made them and each Seer sees only their own, so the promoted Apprentice starts empty (this also separates the logs of two original Seers, which used to be shared).
  - The Seer's check of an unpromoted Apprentice shows village. Included in the random mix (15%, only if a Seer is present).
- **Graveyard Voter** (v1.8.0, internal id `poltergeist`, shown to players as "Graveyard Voter"): village team, decoy prompt. After they die (any cause) they get ONE optional haunt at the next vote that starts (a vote that kills them does not count; an unused haunt expires). Choices:
  - A haunt is a normal vote for any living player (never themselves) or Skip, public in the result list (accepted: it reveals them), counts for ties, Jester election, and Prince immunity. A dedicated Pass action abstains and is not listed. Wolf parity and win checks only ever count living players.
  - **Vote held for the ghost** (v1.10.0, reverses the earlier "no stall" rule): the vote auto-resolves when all living players AND every haunting ghost have voted or passed, and the host's "End vote now" is refused ("Waiting for everyone to vote.") while a connected ghost has not decided. Decision: prefer leaking the ghost's existence to the host over the ghost missing their haunt on timing. So the host progress count now includes the ghost. Other players still learn nothing (`vote.ghosts` is never sent). A ghost whose phone is disconnected does not block, so a dead connection cannot stall the game; the host can then end the vote and the haunt expires.
  - Only the haunting ghost gets the vote prompt on the dead screen (with a Pass button); `vote.ghosts` is never sent in views. No haunt if the game is over. Included in the random mix (15%).
- **Role card description**: the reveal card shows a one- or two-sentence description under the role name (`blurb.<role>`, English and Thai, only the viewer's own role). A test checks every role has one in both languages.
- **Decoy prompts**: Villager, Hunter, Prince, Diseased, Apprentice, Graveyard Voter and Jester all get the same optional "Who do you suspect?" night prompt so nobody can tell who has a power.
- **Announcements**: multi-line dawn / vote results (`state.lines`, sent as `view.announce`) so several deaths in one night each get a line.
- **Tests**: `tests/roles.test.js` (rules), `tests/sim.test.js` (thousands of random headless games, 5–15 players, with an independent win-condition oracle), `tests/e2e.test.js` (full games over the fake PeerJS network with bots).

## Host-run bots (v1.11.0)

- **Bots live in the host's page**, as ordinary players (`bot-N`) in the engine state with no connection. `HostBots` (`js/net/hostbots.js`) gives each bot a random delay when a phase starts, then builds only that bot's view and acts through `host.apply`. The old Client-per-bot helper (`addBots`, ids `cbot-N`) remains for tests.
- **Cap: 20 bots** (`MAX_BOTS`), on top of the 15-human limit (`MAX_PLAYERS` = 35). 1000 was tried: every player's view lists every player and each action broadcasts, so cost grows roughly with the cube of the room size, and a 1000-bot lobby did not get through its first phase in two minutes. Raising it needs batched phases (one pass per phase, not per action), slimmer views and virtualised player lists, plus an auto-advance for the host.
- Rooms over 40 players throttle saving (1s) and view broadcasts (150ms); smaller rooms are unchanged.
- `setBots` is one engine action (host only, lobby only), so adding bots costs one state copy.

## Village suspicions (v1.18.0, setting `suspicions`; on by default since v1.19.0, no host switch since v1.26.0)

- The "Who do you suspect?" prompt that every no-power role gets used to do nothing. With this setting on, those answers are collected (`night.suspects`, host only, never in a view) and dawn adds one line: `Most suspected: <names>.`
- **Checked for game-breaking, and kept safe by these limits.** The answers come only from players with no night power, so anything that shows who answered, or how many answered, tells the table who has a power and how many there are (and defeats the secret random mix). So the line shows names only, never counts or voters, and appears only when at least two answers agree; one lone answer cannot show how many no-power players are alive. A tie names everyone tied.
- Answers about a player who died that night are dropped. Wolves, Seer, Bodyguard and Witch never answer, so the line is village sentiment and proves nothing about roles. The outcome is not fixed by it, so `validate()` is unchanged.
- Known small leak, accepted: when the line appears, at least two no-power players are alive.
- An invalid answer (self, dead player) is ignored, never an error, as before. With the setting off nothing changes.

## Outcome reveal (v1.20.0)

- **What it covers**: every dawn, vote-result and hunter-shot announcement. A death gets a card with a pixel grave, a "Killed in the night" / "Voted out" / "Shot by X" label, the name struck out, and the role when `revealOnDeath` is on. "Nobody died", ties, the Prince, a lowered bow and the Jester twist get their own cards. The suspicion line stays plain text.
- **Full-screen first, then the cards**: new news plays as big cards over a dark full-screen layer (grave drops, dust, red flash, strike), then each big card's grave, name and role fly into the small card on the screen while the dark fades. It lands by itself; a tap only lands it sooner. No extra button press anywhere, and the host's controls are back within about 3 seconds.
- **UI only, built from the public lines**: `js/ui/fx.js` reads only `view.announce`, the same English text every phone gets, so every phone shows the same thing and nothing private can leak. No engine, view or protocol change. Night deaths look identical whatever the cause (wolves or poison), as the text already is. "X was the Jester!" (said when roles stay hidden) folds into X's vote-out card.
- **Plays once**: the screen is rebuilt on every view, so each line remembers it was shown and only plays the first time. The full-screen layer lives on `<body>`, outside the rebuilt screen, so a rebuild can't cut it off. A phone that reloads mid-day sees it again; accepted.
- **Dead players** now see the dawn cards on their screen too (they used to see only "You are out"), so the killed player gets the moment as well.
- **Buzz**: a death also vibrates a heartbeat pattern (Android; iPhone browsers have no vibration).
- **Reduced motion**: no full-screen layer, cards shown at rest.
- **Tests**: `tests/fx.test.js` (every announcement form, Jester fold, Thai labels); the random-game sim checks that every announcement it produces becomes a card and that each card type comes up.

## Sound effects (v1.21.0)

- **What sounds**: nightfall, every outcome card (night death, nobody died, voted out, tie, hunter shot, lowered bow, Prince, Jester) and the village or wolves winning. Each is a short synthesized clip in `assets/sfx/`, picked by ear from three packs; how they were made is in `tools/sfx/README.md`.
- **Own button**: an Effects button sits beside Music and Narrator, so effects mute without touching music. Same defaults and memory as the other two: on for the host, off for other players (a room of phones shouldn't fire the same sound a dozen times), the host's choice kept across games, a player's for that room. Choices saved before 1.21.0 get the default for effects.
- **Nothing secret**: only moments every phone already shows get a sound. Night deaths sound the same whatever the cause, as the card looks the same. No sound for night actions or anything only one phone sees.
- **Timing**: a death sounds as its grave lands, each card's sound on its own card, so two night deaths are two hits a second apart. With reduced motion, one sound for the news. Nightfall and the winner sound only on a real change of phase: a phone that joins or reconnects mid-phase stays quiet.
- **Jester**: voting out the Jester plays the Jester sound on the vote card (twist or role shown) and nothing more on the game-over screen, since it is the same moment. (Changed in 1.25.0: the Jester sound now plays again on the game-over screen when the Jester wins.)
- **Web Audio**: a sound starts when a view arrives, long after the last tap, which phones only allow from an audio context started by a tap. The context starts from the Host or Join tap, or the next tap anywhere. Files load only once a phone turns effects on. A sound that finishes loading after its moment is skipped, never played late. On iPhone, effects play through the silent switch, like the music.
- **Reserved**: `tools/sfx/reserved/dread.mp3` ("Two-note dread") is kept for future random events. (Used since v1.27.0 as `assets/sfx/event.mp3`.)
- **Tests**: `tests/sfx.test.js` (each card's sound and timing, Jester once, phase sounds, every file exists), `tests/sound.test.js` (the effects switch and old saved choices); the random-game sim checks that every card it produces has a sound and that each sound comes up.

## Narration trim and speech after sound (v1.22.0)

- **What is still spoken**: only deaths and what follows them: the dawn announcement, the vote result and the hunter's "one last shot". The night, day and vote openers ("Night falls…", "Day breaks.", "Time to vote.") and the win line ("The wolves win!") are gone: nightfall, the card sounds and the winner sound already say them, and a sound cannot say a name, which is what a table in one room needs to hear. `js/game/lines.js` and its Thai pairs are deleted. A game that ends at dawn still speaks the deaths that ended it, never the win.
- **Call to vote**: voting has no spoken opener now, so it gets a sound, `voteCall` (three knocks and a bell), on the change into the vote phase. Same rules as nightfall: only a real change of phase, so a phone that joins or reconnects mid-vote stays quiet. Rendered by `tools/sfx/render.py` ("Midnight summons"); picked from the code, not by ear.
- **Speech waits for sound**: a spoken line starts after every sound scheduled for the same view has finished, plus a quarter second. The phone records when its last scheduled sound ends and the narrator waits for it. With effects off there is nothing to wait for and speech is immediate. A newer line, or turning the narrator off, cancels one that is still waiting. `main.js` now says the narration after rendering the view, because the screen is what schedules the card sounds.
- **Tests**: `tests/narration.test.js` (what is and is not spoken), `tests/sfx.test.js` (the vote sound, speech waiting for sounds).

## Music only in the lobby (v1.22.2)

- **Why**: the music clashed with the sound effects. Rather than duck it under each sound (tried in 1.22.0 and 1.22.1, then removed), it now plays only while people are waiting.
- **When it plays**: while the lobby is up, from the Host or Join tap. It stops when a game starts and stays off through the reveal, night, day, vote and game-over screens. On Play again the lobby returns and the track continues where it left off, as with any pause. Before the first view arrives (just after the tap) it is allowed, so the tap can start it, which phones require. A phone that rejoins a game in progress never starts it.
- **The button**: the Music button is hidden while a game is on, since pressing it could not do anything. The choice is kept as before (host: across games; player: for that room).
- **Rule**: `musicAllowed(phase)` in `js/ui/soundprefs.js`; `sound.js` applies it on each view's phase.

## Nightfall, win and hunter moments (v1.23.0)

- **Nightfall**: on every change into the night, a full-screen moment: the screen dusks over, the town's windows go dark one by one, the moon rises and "Night N" appears. It shows nothing private, so every phone (alive or dead) gets the same one.
- **Wins**: when the wolves or the village win, a full-screen moment: a blood moon and the pack, or a sunrise and the hopping villagers. At game over every role is public, so showing the team is fine. A host-ended game gets none. (A Jester win got none until 1.25.0.)
- **Fold, no button**: each moment ends by itself and folds into the screen underneath, like the outcome cards: the big title flies onto the screen's own heading ("Night N" label, game-over title) and each team sprite onto that player's row while the sky fades. A tap only ends it sooner. Only shown for a phase change seen live, not on the first view after joining or rejoining.
- **Hunter**: everyone waiting on the hunter's last shot sees a red crosshair drift over the player list (the hunter's own screen is unchanged). "Lowered the bow" is now a real card with a lowered-bow picture that folds in with the dawn news.
- **Bow, not gun**: the Hunter's sprite holds a bow, so the text says bow: "X lowered the bow." and the Thai lines say ธนู. The card parser and Thai rules still read the old "lowered the gun" from a host on an older version.
- **Failed vote**: "Nobody was eliminated" now has a picture (balanced scales), like "Nobody died" has the sun.
- **Reduced motion**: no full-screen moments, no drifting crosshair.

## Game start sound (v1.24.0)

- **What**: `gameStart`, a two-note low brass call (a fifth apart) with a hall tail, about 2.4 seconds, plays on the change from the lobby into the role reveal. Picked by ear from ten options.
- **Same rules as nightfall**: only a real change of phase, so a phone that joins or reconnects during the reveal stays quiet, and Play again is quiet until the host starts the next game. Nothing private is in it: every phone gets the same sound at the same moment, and it says nothing about roles. It follows the Effects button like every other sound.
- **No fade**: the lobby music still stops the moment the game starts. The horn covers the cut. A fade was proposed and dropped, since iPhones ignore `audio.volume`.
- **Speech**: the narrator waits for the sound like it does for every other, so a first line never talks over the horn.
- **Tests**: `tests/sfx.test.js` (game start only on a real change, quiet on rejoin, every file exists).

## Faster force refresh (v1.24.1)

- **Why it was slow**: the button downloaded about 38 files one after another, each a full round trip, so a weak connection took 30 seconds or more. One request that hung held up everything behind it, with no limit.
- **Now**: files are fetched a level of the import graph at a time, all at once. The graph is 4 levels deep, so it takes about 4 round trips. The code is in `js/util/refresh.js`.
- **Time limit**: every request shares one 10 second limit. When it runs out, whatever is still pending is dropped and the page reloads anyway.
- **Unchanged**: the same files are refreshed with `cache:'reload'`, the page's own address included (it is a different cache entry from `index.html`), Cache Storage is cleared, and the session is kept so players rejoin. The host still gets the "this ends the game" warning.
- **Tests**: `tests/refresh.test.js` (every file once with `cache:'reload'`, a level goes out at once, a request that never answers stops at the limit, a failed file is skipped).

## Jester victory moment (v1.25.0, sound v1.25.1)

- **What**: when the Jester wins, the game-over screen opens with a full-screen moment like the wolves and village get: red curtains part on a lit stage, confetti falls, the Jester sprite dances, and "The Jester wins!" lands. Then it folds into the game-over screen the same way: the title onto the heading, the Jester's sprite onto their row. A tap ends it sooner.
- **After the vote card**: the vote result card (confetti, "It was the Jester. Fooled you!") still shows first and still plays the Jester card sound. The win moment comes when the host continues to game over, so the table gets the reveal and then the win, not one blur.
- **Sound** (changed in 1.25.1): the existing Jester sound plays again on the change into game over when the Jester won, because its funny sound fits the moment better than a new fanfare did. Same rules as the other winner sounds: only a real change of phase, so rejoining at game over is quiet, and it follows the Effects button.
- **Public**: at game over every role is public, so showing the Jester is fine. Every phone gets the same moment, whoever won.
- **Reduced motion**: no full-screen moment, as for the other wins.
- **Tests**: `tests/sfx.test.js` (the Jester win sound on a real change of phase, quiet on rejoin, every file exists).

## Fewer host options and new sound defaults (v1.26.0)

- **Removed from the host's lobby**: Village suspicions, Bodyguard can protect self and Narration. Suspicions and Bodyguard self-protect were on by default and nobody had a reason to turn them off; narration is already a per-phone button in the tools row. The engine settings `suspicions`, `bodyguardSelfProtect` and `narration` stay, always at their defaults (on), so the game rules and the engine tests are unchanged.
- **Sound defaults**: music and sound effects are on and narrator is off, for the host and for players. Choices people already saved are kept. Phones still need a tap before audio can start, as before.

## Random events (v1.27.0, setting `randomEvents`, on by default)

- **How often**: about 1 game in 5 (`EVENT_CHANCE` = 0.2) gets a random event, rolled in secret at Start. Lucky Horseshoe is the only one so far. The roll and the coming event stay on the host (`state.event`) and are never in a view, so nobody knows one is coming until its dawn. The host can turn random events off in Other options. The lobby does not state the odds.
- **When**: at the start of a day, after the dawn news and before the suspicion line, on dawn 1 or 2. If the game ends at that dawn, or ended before it, the event never happens.
- **Card and sound**: the dawn line becomes a "Random event" card with a pixel horseshoe and the event sound, `assets/sfx/event.mp3`, the "Two-note dread" that was kept in `tools/sfx/reserved/`. Same rules as every other card: every phone gets the same thing.
- **Lucky Horseshoe**: dawn says "Someone found a lucky horseshoe." A random living player holds it, wolves included. It blocks one wolf attack that would have killed its holder, then it is gone. Choices:
  - **On a wolf it is wasted, and nobody is told**, the wolf included. If wolves were told, they would know any claimer is bluffing. So wolves always have to guess whether a loud claimer is real.
  - **The holder is told privately** (`you.private.horseshoe`): a note on the day screen the day it is found, a reminder under their night prompt while it is unused, and a note the day it saves them. Claiming it or keeping quiet is up to them.
  - **The save looks like any quiet night**: "Nobody died." Nobody else learns it was the horseshoe (as with the Bodyguard). The full detail is in the game-over history.
  - **Order**: the Bodyguard and the Witch's heal go first; the horseshoe is only spent when the attack would otherwise kill. It does not stop the Witch's poison or a vote.
- **Restless Dead, cut**: proposed as Séance (every dead player gets a haunt vote at the next vote, reusing the Graveyard Voter's `vote.ghosts`). Built and measured, then cut: on dawn 2 or 3 it moved the village win rate by up to +10 points at 8 players, because night victims are never wolves, so the dead lean village. Numbers are in `tools/balance/README.md`.
- **Balance** (`tools/balance/`, 20,000 games per cell, 6/8/10/12 players, low/mid/high skill): Lucky Horseshoe moves the village win rate by +1.0 to +2.9 points per occurrence if the holder stays quiet, and by about 0 if the holder claims (the wolves then leave them alone).
- **Tests**: `tests/events.test.js` (the roll, the rules, secrecy, the switch, the card, sound and Thai). The random-game sim checks the event rate, that the horseshoe is found, used and wasted on wolves, that only the holder learns anything, and that the coming event is never sent.

## Sound choices persist (v1.27.1)

- **Bug**: a player's Music, Narrator and Effects choices were saved only for the room they were set in, so every new game reset them and the music came back on.
- **Now**: a phone's choices are saved in localStorage and kept across games, for the host and for players. Host and player keep separate saved choices, so a host's settings still do not leak to playing. Choices saved by older versions (with a room code) apply in any room. A choice saved before effects existed gets the default for it (on).
- **Supersedes** the "for that room" and "a player's for that room" lines in the Sound effects (v1.21.0) and Music only in the lobby (v1.22.2) sections.

## Removing players (v1.28.0)

- **Why**: a phone that is stuck or has lost its connection so the game cannot go on. It is for exceptional cases, so it is kept out of the normal flow.
- **Who and where**: only the host. In the lobby, each human player's row has a Remove button. In a game, a small "Manage players" button at the bottom opens a sheet with every other human and their connection dot. Remove asks for a second tap. The host and bots cannot be removed.
- **No ban**: the host hangs up on the phone, and it can come back. A stuck phone reconnects on its own with a fresh connection and the same id. Lobby: the player is taken off the list and comes straight back on it. In a game: the player is out of the game (below) and comes back as a spectator. Room codes are high entropy, so abuse is not a concern now. If it becomes one, add a ban together with an unban, never a ban alone.
- **In a game**: the player is eliminated quietly. It counts as a death for win checks (the game ends at once if a side has won) and for who is still to act, but it triggers nothing: no Hunter shot, no Wolf Cub revenge night, no Apprentice promotion. A pending Hunter shot owed by a removed Hunter is dropped. Night picks and votes from the player are discarded, and votes cast for them count as Skip. If their action was the only thing the phase was waiting for (the last wolf's pick, the last vote), the phase carries on by itself.
- **Announcement**: "X was removed by the host." as a plain line, with no card and no sound. During the reveal, the night or an open vote it is announced with the next dawn or vote result. The role is shown only if Reveal on death is on, like any other death.
- **After the game**: nothing is removed, the phone just reconnects. On Play again everyone is a normal player.
- **Tests**: `tests/kick.test.js` (each rule above, and the network path), and the random-game sim removes players in about a quarter of games, in any phase, and checks the board invariants, that nothing leaks and that a removed phone can only come back as a spectator.

## The last deaths play before the win (v1.28.2, v1.28.3)

- **Why**: when a dawn kill or a Hunter's last shot ended the game, the phones went straight to the game-over screen and the win moment. The death cards (grave, struck name, "Shot by X") only exist on the day, vote and dead screens, so nobody saw how it ended and had to read the history.
- **Order**: on a game that has just ended on such a death: the cards play full-screen, like any other news; the win moment then fades in over them (with its sound); and only after it folds does the game-over screen show, with the roster. The screen is never visible between the cards and the win, so nothing is given away early. The cards hand straight over to the win moment instead of folding into the screen as other news does. A tap skips ahead to the win.
- **What is shown**: the deaths, hunter shots, Prince and Jester lines of that last dawn or shot chain. Suspicions, random events and "nobody died" are left out. The game-over screen also keeps them as a "How it ended" list above the roster.
- **Not replayed**: a game that ends straight out of a vote already showed its cards on the vote screen, so it gets the win at once and the list is just shown. A phone that joins or rejoins a finished game, and a game ended by the host, get no full-screen cards or win moment. With reduced motion there is no full-screen anything, and the win sound plays at once.
- **Code**: `finalLines(view)` and the `quiet`, `onDone` and `handoff` options of `fxAnnounce` in `js/ui/fx.js`; `winSfx` in `js/ui/sfx.js`; the win is held back in `js/main.js` (`pendingWin`, `ctx.afterFinalCards`).
- **Also in 1.28.1**: the strike on a dead player's name is drawn per line, so a name that wraps is struck on every line.

## Smart bots and table talk (v1.29.0, setting `dumbBots`, off by default)

- **Why**: bots picked every target at random, never told anyone anything, and skipped votes at random, so a bot game had no story. Bots now play with reasons and talk.
- **Brain** (`js/bots/mind.js`, one `BotMind` per bot per game, kept by `HostBots`): it reads only `viewFor(state, botId)`, the view that bot's phone would get, and remembers what it has seen: the dawn and vote news, vote results, table talk and its own Seer checks. From that it keeps a suspicion score per player. Wolves copy a teammate's kill pick and otherwise go for a claimed Seer or whoever is hunting the pack; the Seer checks people it has not checked; the Bodyguard guards a lone claimed Seer or itself; the Witch heals itself or a claimed Seer and poisons a strong suspect; no-power roles give their top suspect as the night "suspect" answer (so the "Most suspected" line now means something with bots); everyone votes for their top suspect (wolves for the village's favourite target that is not a teammate, rarely their own teammate); the Hunter shoots its top suspect; the Jester votes at random. Reads are noisy, so bots stay beatable.
- **Personalities** (public, set when a bot joins, never tied to the role, shown as a tag next to the bot's name): Sheep (follows the crowd), Hothead (talks first and loudest), Quiet (says little, skips more), Detective (talks about vote patterns, fewer mistakes).
- **Table talk**: a new engine action `botSay {key, v, ids}`, host-run bots only, living, in the day or while the vote is open, at most 4 lines per bot per round. Lines are stored as a kind of line, a wording and the players it names (`js/game/chat.js`), so each phone renders them in English or Thai (`chat.*` in `js/i18n.js`). The last 60 lines are in every view (`view.chat`) and the day, vote and dead screens show the current round's lines as a feed. The screens show only the latest few lines (3, or 2 on the vote screen), so nothing scrolls inside the page and the player list stays near the top. A "Full discussion (n)" button opens the whole round in a bottom sheet, the only thing that scrolls while it is open (the page behind is locked). The sheet opens at the newest line, keeps the reader's place if they scrolled up, and shows a "New lines" button when more arrive (v1.29.1). With narration on, a phone also speaks the newest line in that bot's own voice, but only when nothing else is being said, so it never talks over the narrator.
- **What bots say**: reactions to deaths, accusations, agreeing, vouching, defending themselves when accused or most suspected, Seer claims and later reports, calling out a fake Seer, a Detective's "A voted out B, and B was a villager", their vote said out loud just before voting (never a lie), and filler. A real Seer goes public once it finds a wolf, or when it is under fire; it only calls a claimant a liar once that claimant contradicts its own checks, so two real Seers do not fight. A wolf may counter-claim a Seer who named its pack and then "report" fake checks, and rarely opens with a fake claim.
- **Checked for leaks**: whether a bot talks, when, and which everyday line it picks depend on its personality and the public situation, never on its role. Every living bot gets the same chance to answer Seer talk, so answering says nothing. The only role-driven lines are the choices a person would make on purpose: claiming Seer (truthfully or not), a wolf not accusing its teammates, a Jester baiting the vote more often (any Hothead may bait too). A test gives the same view and dice to every non-wolf role and checks they say and do the same things, and that every no-power role gives the same night answer.
- **Not too chatty**: outside the vote, the whole table says at most `min(14, 5 + 2√bots)` lines a round (Seer talk gets a few lines past that).
- **Dumb bots**: the lobby switch (shown once there are bots) brings back the old random bots: no talk, no personality tags. The engine refuses `botSay` then.
- **Balance**: rules are unchanged, so the balance simulator is not involved. Bots only change games that have bots. In headless bot games with a skipping host, the village won 6 of 25 with smart bots against 1 of 25 with dumb bots, and 19 of 25 with role reveal on.
- **Checked at scale**: 600 headless games (4 to 20 bots; plain, role reveal, random chaos, MAX chaos, hidden votes, dumb bots): no stalls, no rejected bot actions, no vote announcement that differed from the vote cast (0 of 5,556), real Seer talk always true, about 7 lines per round (16 at most). Only one wolf per pack fakes a Seer, so fake Seer lines stay below real ones. The mix of everyday lines is about the same for wolves, Seers and no-power roles.
- **Tests**: `tests/smartbots.test.js` (engine rules for `botSay`, translations, the leak checks, role decisions, and full bot games where claims, counters, reports and accusations all happen; dumb bots stay silent).

## Role pixel art in the host's setup, and a hidden bot type (v1.30.0)

- **Role rows show their sprite.** Each role row in the host's "Game setup" (and the Villagers total) gets the role's existing 16x16 pixel sprite at 32px, left of the name. Same sprites as the role card, so nothing new to draw or translate. It is the host's screen only; players never see the setup.
- **The bot type is the host's secret.** `viewFor` drops `settings.dumbBots` for every player except the host, and no view carries a bot's personality tag (`persona`) any more, the host's included. Smart bots had a tag and dumb bots had none, so any phone could read the type from the player list. Reverses the v1.29.0 rule that a bot's personality is public. The personality still drives how a smart bot plays and talks; it is just never shown. Known and accepted: smart bots still talk in the table talk, so a table can tell by how they play, as with any other player.
- **Tests**: `tests/smartbots.test.js` checks that `dumbBots` never reaches a non-host view and that no view shows a personality, smart or dumb; the host still sees the switch.

## The Day Before (v1.31.0)

- **What**: one talk round between the role reveal and the first night. The host's reveal button now says "Start discussion" and leads to a day screen titled "The Day Before" (Thai: วันก่อนหน้า). The host's button there is "Start night". The table talks in person; smart bots talk in the table talk feed exactly as on any day. There is no setting: a table that does not want it taps "Start night" straight away, one extra tap.
- **Engine**: it is the `day` phase with `round: 0`. `nextPhase` from the reveal starts it (it used to start night 1); `nextPhase` on day 0 starts night 1. `startVote` is refused on day 0 ("There is no vote before the first night."), and `nextPhase` on any later day is still refused, so a normal day still ends through the vote. Round 0 is its own chat round, so bots get their normal per-round line cap again at day 1. Nothing else changes: no deaths, no announcement lines, no prompt, no host progress count.
- **Bots**: no new code. `HostBots` already schedules talk for every `day` phase, and a `BotMind` already reads round 0 like any other round. Checked for leaks, because this is the one round where no bot has information: the real Seer has no checks yet, so it says nothing; wolves only fake a Seer claim from round 2 on; so no bot of any role claims or reports on day 0. What remains is what the bots already did everywhere: accusations and defences driven by personality and noise (wolves never accuse a teammate, Jesters bait more), which the v1.29.0 leak rules already accept. A test runs every role through day 0 over 150 seeds and checks no Seer line comes out.
- **Views and UI**: no view or protocol change. `dayScreen` has a round 0 variant (no news card, a short "nothing has happened, no vote" line, the table talk feed, the player list). The nightfall moment and sound still play on the change into night 1, since that change is still day to night.
- **Removing a player** on day 0 works as on any day (announced at once, win check runs).
- **Tests**: `tests/daybefore.test.js` (the flow, no vote, nothing announced, bots talk with smart bots and stay silent with dumb ones, the leak check, Thai text). The random-game sim plays The Day Before in every game and checks that nobody has died, nothing is announced and a vote is refused. Existing tests that drove the reveal straight to night now go through day 0.

## Quick chat for people (v1.32.0)

- **Why**: bots talk, and a person could not answer. If the bots turned on one person, that person had no way to argue, accuse back, or claim.
- **Say chip and sheet** (`js/ui/quickchat.js`): a small "Say…" chip sits in the table talk header on the day and vote screens, next to "Full discussion". It adds no height once talk has started. It opens a bottom sheet of fixed sentences, one tap each, and no text box. A sentence that names someone goes to a second step with a list of living players. Tapping a name sends and closes the sheet. The sheet shows how many lines are left this round.
- **Shown everywhere**: the chip is on for every living player in every room, with or without bots, smart or dumb. It cannot show the bot type, and the menu is the same for every role, so it cannot show who has a power.
- **Lines**: accuse, agree, vouch, defend, bait, "I'm the Seer, A is / isn't a wolf", "A is lying, I'm the real Seer", "my vote: A", and skip (`HUMAN_KEYS` in `js/game/chat.js`). Each is one fixed wording. Left out on purpose: news reactions (rip, gotOne, oops), and the Detective line, because a person has no verified record to quote. Any role may post any line, a lie included, as a bot may.
- **Engine** (`say{key, v, ids}`): living humans only, in the day or while the vote is open, 4 lines per person per round, only `HUMAN_KEYS`, names must be other living players, no repeats. The line is stored in the same shape and the same public feed as a bot line. The answer never depends on the sender's role or on `dumbBots`. On the wire the wording rides in `variant`, because `v` is the protocol version of every message.
- **Same weight as a bot**: bots read chat by the kind of line, never by who wrote it, so a person's line moves them exactly as a bot's would. Reads stay noisy and personality driven, so persuasion is unreliable, as it is between bots. There is no special rule: no "plead" line, defend does not clear anyone, and bots do not answer a person differently. A test runs the same lines from a person and from a bot in the same seat and checks every other bot ends up with the same scores, lines and votes.
- **Table cap**: a person's lines do not count toward the table's line cap, so a talkative person does not silence the bots. Narration does not read a person's line aloud, because they can say it themselves.
- **Slow typists get answers** (`HUMAN_REPLIES = 2` in `js/net/hostbots.js`): a person usually speaks after the bots have said their share, so a person's line gets its own budget of 2 answers. They skip the table's line cap and may use the one spare line a bot keeps back (3 of the 4 the engine allows are for normal talk). Bots named in the line answer first, and Seer talk is still open to every bot so answering says nothing about a role. Only lines that are posted use the budget. The answers are quiet: they start no replies of their own, so one message never sets off a chain, and bot-to-bot talk stays under the old cap. Bots that have not voted yet also weigh the line, because every bot re-reads the whole feed when it votes.
- **The Day Before** (round 0, added upstream in the same release window): people can use the Say sheet there too, with their own 4-line allowance, since chat lines are kept per round. Nothing has happened yet, so a bot's opening accusation has nothing behind it: bots start them at a quarter of their usual rate on day 0 (`DAY_BEFORE_ACCUSE = 0.25` in `js/bots/mind.js`). The factor depends only on the round, so it is the same for every role and personality and says nothing about who has a power. Bots still weigh and answer a person's line on day 0 as on any day.
- **Day 0 line audit**: I read every kind of line against a round with no deaths, no vote and no night behind it. Allowed on day 0: accuse, agree, vouch, defend, filler. Refused: rip, gotOne, oops (nobody has died or been voted out), detective (no vote to quote), the Seer lines claimWolf, claimClean, reportWolf, reportClean and counter (nobody has a check before night 1), and bait, voteFor, voteSkip (there is no vote, so "vote me" and "I'm skipping this one" make no sense). `DAY_BEFORE_KEYS` and `validOnRound` in `js/game/chat.js` hold the list. The engine refuses the refused kinds on round 0 for bots and people alike, the bot mind never picks them there (a Jester or Hothead does not bait, a Seer has nothing to claim), and the Say sheet lists only accuse, agree, vouch and defend. The rule depends only on the round, so it says nothing about a role.
- **Balance**: rules are unchanged, so the balance simulator is not involved. The muted-players run (2026-11-19, `tools/balance/README.md`) found silent players die less, not more, so this is about giving people a voice, not about fixing a loss rate.
- **Tests**: `tests/quickchat.test.js` (engine rules, role and bot-type independence, protocol checks, person-versus-bot equivalence, the cap, the reply budget for a late line, Thai strings, and whole games with a person posting every day).

## Bodyguard and protection lines (v1.33.0)

- **Why**: the Seer can say what she found, the Bodyguard could not say anything, and nobody could ask to be saved. Four new fixed lines in `CHAT` (`js/game/chat.js`), all in the Say sheet's menu.
- **Bodyguard lines** (people only): `claimGuard` "I'm the Bodyguard, I guarded A last night" and `counterGuard` "A is lying, I'm the real Bodyguard". Any role may post either, a lie included. Refused on day 0 (nobody has guarded yet), like the Seer lines. Bots never post them.
- **Protection pleas**: `protectMe` "Please protect me" and `protectThem` "Please protect A". They name no role: they ask whoever can protect someone, so they say nothing about who has a power. Allowed on day 0, because they lean on nothing that has happened (night 1 is next). Bots post them too.
- **What a Bodyguard claim proves**: nothing. The engine only accepts a living target, and the save looks like any quiet night, so a claim cannot be checked. Bots read it as a soft signal in `readGuard` (`js/bots/mind.js`): two claimants cannot both be the Bodyguard (each gets +1 suspicion, once per pair), the same target on two nights running is against the rules (+2), and a counter adds +1 to the named player and makes a named bot defend itself. A claim never clears its target, and wolves do not hunt a claimed Bodyguard the way they hunt a claimed Seer.
- **Who pleads (bots)**: `pleaLine`, once per round, uses only public facts and the bot's own reads, never its role. A claimed Seer (real or fake) asks for itself 60% of the time, a bot under fire 15%, a bot that trusts a claimed Seer (score under 1) asks for them 20%, everyone else 3%. A test checks the answer is the same for every role.
- **Who answers a plea**: a Bodyguard bot picks a player who asked for protection last day, if it does not suspect them (score under 0.5), half the time. Anyone may ask, wolves included. This is the one rule change here: the Bodyguard bot's night pick. Bots do not reply to a plea in chat, so a plea draws no answers from the table.
- **Bubble**: Bodyguard lines get a green left edge, as Seer lines get blue.
- **Balance**: not measured. `tools/balance/` models talk its own way and has no plea or Bodyguard claim, so the Bodyguard bot's new pick (a plea nudges one night pick in two) is untested there. People's lines change no rule.
- **Tests**: `tests/quickchat.test.js` (Thai and English text for every wording, day 0 rules, the claim signals, the Bodyguard bot's pick, plea rule independent of role, bots do plead).
