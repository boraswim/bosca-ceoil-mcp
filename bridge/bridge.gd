# Runs inside Bosca Ceoil Blue and exposes the running app over a local socket.
#
# Requests and responses are newline-delimited JSON:
#   -> {"id": 1, "token": "...", "method": "get_song", "params": {}}
#   <- {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": "..."}
#
# A method named "foo" is handled by cmd_foo(params). Handlers work on the app's
# own objects and report failure by returning _err(). Edits go through the app's
# StateManager, so they appear live in the UI and Ctrl+Z works on them.
extends Node

const PROTOCOL_VERSION := 1
const HOST := "127.0.0.1"
const MAX_REQUEST_BYTES := 8 * 1024 * 1024
const HEADLESS_IDLE_QUIT_SECONDS := 30.0

const NOTE_NAMES: PackedStringArray = [ "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" ]
const NOTE_LETTERS := { "C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11 }

## Methods which stay available while a WAV is rendering.
const READ_ONLY_METHODS: PackedStringArray = [ "status", "export_status", "get_song", "list_voices", "get_drumkit", "screenshot" ]

var session_path: String = ""

var _server: TCPServer = TCPServer.new()
var _clients: Array[Client] = []
var _token: String = ""
var _headless: bool = false
var _idle_time: float = 0.0
var _note_pattern: RegEx = RegEx.new()
## State of the current or most recent WAV export.
var _export_job: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_headless = DisplayServer.get_name() == "headless"
	_note_pattern.compile("^([A-Ga-g])([#b]?)(-?\\d+)$")

	# The app starts playing its empty song on launch. Nothing should make sound
	# until it's asked to.
	Controller.music_player.stop_playback()

	_token = Crypto.new().generate_random_bytes(24).hex_encode()

	var error := _server.listen(0, HOST)
	if error != OK:
		printerr("McpBridge: Failed to open a local socket (code %d)." % [ error ])
		Controller.get_tree().quit(1)
		return

	_write_session_file()
	print("McpBridge: Listening on %s:%d." % [ HOST, _server.get_local_port() ])


func _exit_tree() -> void:
	_server.stop()

	# Only remove the session file if it's still ours. A newer instance may have replaced it.
	if session_path.is_empty() || not FileAccess.file_exists(session_path):
		return

	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(session_path))
	if parsed is Dictionary && parsed.get("token", "") == _token:
		DirAccess.remove_absolute(session_path)


func _process(delta: float) -> void:
	while _server.is_connection_available():
		_clients.push_back(Client.new(_server.take_connection()))

	for i in range(_clients.size() - 1, -1, -1):
		var client := _clients[i]
		client.peer.poll()
		if client.peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			_clients.remove_at(i)
			continue

		_read_client(client)

	# A window-less instance has no one to close it when the AI tool goes away.
	if _headless:
		if _clients.is_empty() && _export_job.get("state", "") != "rendering":
			_idle_time += delta
			if _idle_time >= HEADLESS_IDLE_QUIT_SECONDS:
				Controller.get_tree().quit()
		else:
			_idle_time = 0.0


func _write_session_file() -> void:
	if session_path.is_empty():
		return

	var file := FileAccess.open(session_path, FileAccess.WRITE)
	if not file:
		printerr("McpBridge: Failed to write the session file at '%s'." % [ session_path ])
		return

	file.store_string(JSON.stringify({
		"protocol": PROTOCOL_VERSION,
		"port": _server.get_local_port(),
		"token": _token,
		"pid": OS.get_process_id(),
		"version": ProjectSettings.get_setting("application/config/version"),
		"headless": _headless,
	}))
	file.close()


# Transport.

func _read_client(client: Client) -> void:
	var available := client.peer.get_available_bytes()
	if available > 0:
		var received := client.peer.get_partial_data(available)
		if received[0] == OK:
			client.buffer.append_array(received[1])

	if client.buffer.size() > MAX_REQUEST_BYTES:
		client.peer.disconnect_from_host()
		return

	while true:
		var line_end := client.buffer.find(10)
		if line_end < 0:
			return

		var line := client.buffer.slice(0, line_end).get_string_from_utf8()
		client.buffer = client.buffer.slice(line_end + 1)
		_send(client, _handle_line(line))


func _send(client: Client, response: Dictionary) -> void:
	client.peer.put_data((JSON.stringify(response) + "\n").to_utf8_buffer())


func _handle_line(line: String) -> Dictionary:
	var request: Variant = JSON.parse_string(line)
	if not request is Dictionary:
		return { "id": null, "ok": false, "error": "Malformed request." }

	var id: Variant = request.get("id")
	if request.get("token", "") != _token:
		return { "id": id, "ok": false, "error": "Invalid token." }

	var method: String = str(request.get("method", ""))
	var handler := "cmd_" + method
	if method.is_empty() || not has_method(handler):
		return { "id": id, "ok": false, "error": "Unknown method '%s'." % [ method ] }

	if not READ_ONLY_METHODS.has(method) && Controller.is_song_editing_locked():
		return { "id": id, "ok": false, "error": "The app is busy exporting. Check export_status and try again when it's done." }

	var params: Variant = request.get("params", {})
	var result: Variant = call(handler, params if params is Dictionary else {})

	# A script error inside a handler aborts it and leaves us with null.
	if result == null:
		return { "id": id, "ok": false, "error": "The bridge failed to handle '%s'. See the app log for details." % [ method ] }
	if result is Dictionary && result.has("__error"):
		return { "id": id, "ok": false, "error": result["__error"] }
	return { "id": id, "ok": true, "result": result }


func _err(message: String) -> Dictionary:
	return { "__error": message }


func _is_err(value: Variant) -> bool:
	return value is Dictionary && value.has("__error")


# Values and formatting.

func _note_name(value: int) -> String:
	return "%s%d" % [ NOTE_NAMES[posmod(value, 12)], floori(value / 12.0) - 1 ]


func _parse_pitch(text: String) -> int:
	var found := _note_pattern.search(text.strip_edges())
	if not found:
		return -1

	var value: int = NOTE_LETTERS[found.get_string(1).to_upper()]
	match found.get_string(2):
		"#": value += 1
		"b": value -= 1
	return value + (found.get_string(3).to_int() + 1) * 12


func _parse_key(value: Variant) -> Variant:
	if value is float || value is int:
		var key := int(value)
		return key if key >= 0 && key < Note.MAX else _err("Key must be between 0 and 11.")

	var text := str(value).strip_edges()
	var key_index := NOTE_NAMES.find(text.to_upper())
	if key_index >= 0:
		return key_index

	var flat := _parse_pitch(text + "4")
	if text.length() == 2 && flat >= 0:
		return posmod(flat, 12)
	return _err("Unknown key '%s'. Use one of: %s." % [ value, ", ".join(NOTE_NAMES) ])


func _scale_label(scale: int) -> String:
	return Scale.get_scale_name(scale).to_lower().trim_prefix("scale: ")


func _parse_scale(value: Variant) -> Variant:
	if value is float || value is int:
		var scale := int(value)
		return scale if scale >= 0 && scale < Scale.MAX else _err("Scale must be between 0 and %d." % [ Scale.MAX - 1 ])

	var text := str(value).strip_edges().to_lower().replace("_", " ").trim_prefix("scale: ").trim_prefix("scale ")
	var labels: PackedStringArray = []
	for i in Scale.MAX:
		var label := _scale_label(i)
		if label == text:
			return i
		labels.push_back(label)
	return _err("Unknown scale '%s'. Use one of: %s." % [ value, ", ".join(labels) ])


func _parse_effect(value: Variant) -> Variant:
	if value is float || value is int:
		var effect := int(value)
		return effect if effect >= 0 && effect < Effect.MAX else _err("Effect must be between 0 and %d." % [ Effect.MAX - 1 ])

	var text := str(value).strip_edges().to_upper().replace("_", " ")
	var labels: PackedStringArray = []
	for i in Effect.MAX:
		if Effect.get_effect_name(i) == text:
			return i
		labels.push_back(Effect.get_effect_name(i).to_lower())
	return _err("Unknown effect '%s'. Use one of: %s." % [ value, ", ".join(labels) ])


func _parse_voice(value: Variant) -> Variant:
	var vm: VoiceManager = Controller.voice_manager

	if value is float || value is int:
		var index := int(value)
		if index < 0 || index >= vm._voices.size():
			return _err("Voice index %d doesn't exist. Use list_voices to see what's available." % [ index ])
		return vm._voices[index]

	var text := str(value).strip_edges().to_lower()
	var exact: Array[VoiceManager.VoiceData] = []
	var partial: Array[VoiceManager.VoiceData] = []
	for voice in vm._voices:
		var full := "%s/%s" % [ voice.category.to_lower(), voice.name.to_lower() ]
		if text == full || text == voice.name.to_lower():
			exact.push_back(voice)
		elif full.contains(text):
			partial.push_back(voice)

	var matches := exact if not exact.is_empty() else partial
	if matches.size() == 1:
		return matches[0]
	if matches.is_empty():
		return _err("No voice matches '%s'. Use list_voices to see what's available." % [ value ])

	var options: PackedStringArray = []
	for voice in matches.slice(0, 10):
		options.push_back("%s/%s" % [ voice.category, voice.name ])
	return _err("'%s' is ambiguous. Did you mean: %s?" % [ value, ", ".join(options) ])


func _is_drumkit(instrument: Instrument) -> bool:
	return instrument.type == Instrument.InstrumentType.INSTRUMENT_DRUMKIT


func _valid_scale_values(scale: int) -> Dictionary:
	var valid := {}
	var layout := Scale.get_scale_layout(scale)
	var value := 0
	var i := 0
	while value < Pattern.MAX_NOTE_VALUE:
		valid[value] = true
		value += layout[i % layout.size()]
		i += 1
	return valid


func _note_label(value: int, instrument: Instrument) -> String:
	if _is_drumkit(instrument):
		var drumkit := instrument as DrumkitInstrument
		return drumkit.get_note_name(value) if value >= 0 && value < drumkit.voices.size() else str(value)
	return _note_name(value)


## Resolves a note given as a number, a pitch name, or a drumkit item name.
## Returns a note value, or an error.
func _parse_note_value(raw: Variant, instrument: Instrument) -> Variant:
	if raw is float || raw is int:
		return int(raw)

	var text := str(raw).strip_edges()
	if _is_drumkit(instrument):
		var drumkit := instrument as DrumkitInstrument
		var data := drumkit._voice_data as VoiceManager.DrumkitData
		for i in data.items.size():
			if data.items[i].name.to_lower() == text.to_lower():
				return i
		return _err("'%s' is not in the %s. Use get_drumkit to see its items." % [ text, drumkit.name ])

	var value := _parse_pitch(text)
	return value if value >= 0 else _err("'%s' is not a valid note. Use a name like C4 or F#5, where C4 is 60." % [ text ])


## Converts note input into validated note data, checking them against the rules
## the app's note grid follows. Notes that break those rules would be invisible
## in the UI but would still play, so they are rejected here.
func _parse_notes(raw_notes: Variant, key: int, scale: int, instrument: Instrument, pattern_size: int) -> Variant:
	if not raw_notes is Array:
		return _err("Notes must be a list.")

	var drumkit := _is_drumkit(instrument)
	var valid_values := _valid_scale_values(scale)
	var notes: Array[Vector3i] = []
	var problems: PackedStringArray = []
	var off_scale := false

	for raw: Variant in raw_notes:
		if not raw is Dictionary || not raw.has("note") || not raw.has("pos"):
			problems.push_back("every note needs 'note' and 'pos'")
			continue

		var value: Variant = _parse_note_value(raw["note"], instrument)
		if _is_err(value):
			problems.push_back(value["__error"])
			continue

		var note_value: int = value
		var position := int(raw["pos"])
		var length := int(raw.get("len", 1))
		var label := _note_label(note_value, instrument)

		if position < 0 || position >= pattern_size:
			problems.push_back("%s at pos %d is outside the pattern (0-%d)" % [ label, position, pattern_size - 1 ])
		elif length < 1 || length > Pattern.MAX_NOTE_LENGTH:
			problems.push_back("%s at pos %d has an invalid length %d (1-%d)" % [ label, position, length, Pattern.MAX_NOTE_LENGTH ])
		elif drumkit && (note_value < 0 || note_value >= (instrument as DrumkitInstrument).voices.size()):
			problems.push_back("drumkit item %d doesn't exist in the %s" % [ note_value, instrument.name ])
		elif not drumkit && (note_value - key < 0 || note_value - key >= Pattern.MAX_NOTE_VALUE):
			problems.push_back("%s is outside the playable range for this key" % [ label ])
		elif not drumkit && not valid_values.has(note_value - key):
			problems.push_back("%s at pos %d isn't in %s %s" % [ label, position, NOTE_NAMES[key], _scale_label(scale) ])
			off_scale = true
		else:
			notes.push_back(Vector3i(note_value, position, length))

	if not problems.is_empty():
		var shown := problems.slice(0, 8)
		var suffix := " (and %d more)" % [ problems.size() - 8 ] if problems.size() > 8 else ""
		var hint := ""
		if off_scale:
			hint = " %s %s has: %s. Use scale \"normal\" to allow any note." % [ NOTE_NAMES[key], _scale_label(scale), ", ".join(_scale_note_names(key, scale)) ]
		return _err("Invalid notes: %s%s.%s" % [ "; ".join(shown), suffix, hint ])
	return notes


func _scale_note_names(key: int, scale: int) -> PackedStringArray:
	var names: PackedStringArray = []
	var value := 0
	for step in Scale.get_scale_layout(scale):
		names.push_back(NOTE_NAMES[(key + value) % 12])
		value += step
	return names


## Fails if notes share a pitch and a start position or don't fit in one pattern.
func _check_note_list(notes: Array[Vector3i], instrument: Instrument) -> Variant:
	if notes.size() > Pattern.MAX_NOTES_IN_PATTERN:
		return _err("A pattern can only hold %d notes, this would make it %d." % [ Pattern.MAX_NOTES_IN_PATTERN, notes.size() ])

	var seen := {}
	for note in notes:
		var note_key := Vector2i(note.x, note.y)
		if seen.has(note_key):
			return _err("%s starts twice at pos %d." % [ _note_label(note.x, instrument), note.y ])
		seen[note_key] = true
	return true


func _serialize_pattern(index: int, pattern: Pattern, include_notes: bool = true) -> Dictionary:
	var song: Song = Controller.current_song
	var instrument := song.instruments[pattern.instrument_idx]
	var data := {
		"index": index,
		"instrument": pattern.instrument_idx,
		"note_count": pattern.note_amount,
	}

	if not _is_drumkit(instrument):
		data["key"] = NOTE_NAMES[pattern.key]
		data["scale"] = _scale_label(pattern.scale)

	if include_notes:
		var notes: Array[Dictionary] = []
		for i in pattern.note_amount:
			var note := pattern.notes[i]
			notes.push_back({ "note": _note_label(note.x, instrument), "pos": note.y, "len": note.z })
		notes.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["pos"] < b["pos"])
		data["notes"] = notes

	if pattern.record_instrument:
		data["record_filter"] = true
		if include_notes:
			var steps: Array[Dictionary] = []
			for i in song.pattern_size:
				var values := pattern.recorded_instrument_values[i]
				steps.push_back({ "pos": i, "volume": values.x, "cutoff": values.y, "resonance": values.z })
			data["filter_steps"] = steps

	return data


func _serialize_instrument(index: int, instrument: Instrument) -> Dictionary:
	return {
		"index": index,
		"voice": "%s/%s" % [ instrument.category, instrument.name ],
		"drumkit": _is_drumkit(instrument),
		"volume": instrument.volume,
		"cutoff": instrument.lp_cutoff,
		"resonance": instrument.lp_resonance,
	}


func _serialize_song(include_notes: bool) -> Dictionary:
	var song: Song = Controller.current_song

	var instruments: Array[Dictionary] = []
	for i in song.instruments.size():
		instruments.push_back(_serialize_instrument(i, song.instruments[i]))

	var patterns: Array[Dictionary] = []
	for i in song.patterns.size():
		patterns.push_back(_serialize_pattern(i, song.patterns[i], include_notes))

	var bars: Array = []
	var arrangement := song.arrangement
	for i in arrangement.timeline_length:
		var channels: Array = []
		for pattern_idx in arrangement.timeline_bars[i]:
			channels.push_back(pattern_idx if pattern_idx >= 0 else null)
		bars.push_back(channels)

	return {
		"file": song.filename,
		"unsaved_changes": song.is_dirty(),
		"bpm": song.bpm,
		"pattern_size": song.pattern_size,
		"bar_size": song.bar_size,
		"swing": song.swing,
		"effect": Effect.get_effect_name(song.global_effect).to_lower(),
		"effect_power": song.global_effect_power,
		"instruments": instruments,
		"patterns": patterns,
		"arrangement": { "bars": bars, "loop_start": arrangement.loop_start, "loop_end": arrangement.loop_end },
	}


func _song_summary() -> Dictionary:
	var song: Song = Controller.current_song
	return {
		"file": song.filename,
		"unsaved_changes": song.is_dirty(),
		"bpm": song.bpm,
		"pattern_size": song.pattern_size,
		"instruments": song.instruments.size(),
		"patterns": song.patterns.size(),
		"bars": song.arrangement.timeline_length,
		"loop_start": song.arrangement.loop_start,
		"loop_end": song.arrangement.loop_end,
	}


func _check_index(value: Variant, size: int, label: String) -> Variant:
	if not (value is float || value is int):
		return _err("%s index is required." % [ label ])
	var index := int(value)
	if index < 0 || index >= size:
		return _err("%s %d doesn't exist (the song has %d)." % [ label, index, size ])
	return index


func _check_discard(params: Dictionary) -> Variant:
	if Controller.current_song.is_dirty() && not params.get("discard_changes", false):
		return _err("The current song has unsaved changes. Save it first, or set discard_changes to true if losing them is okay.")
	return true


func _normalize_path(raw: Variant, extension: String) -> Variant:
	var path := str(raw).strip_edges().replace("\\", "/")
	if path.is_empty():
		return _err("A file path is required.")
	if not path.is_absolute_path():
		return _err("The path must be absolute: %s" % [ path ])
	if path.get_extension().to_lower() != extension:
		return _err("The file must have a .%s extension: %s" % [ extension, path ])
	return path


func _check_writable(path: String, params: Dictionary) -> Variant:
	if not DirAccess.dir_exists_absolute(path.get_base_dir()):
		return _err("The folder doesn't exist: %s" % [ path.get_base_dir() ])
	if FileAccess.file_exists(path) && not params.get("overwrite", false):
		return _err("A file already exists at %s. Set overwrite to true to replace it." % [ path ])
	return true


# State changes. Each call makes one undo step in the app.

func _commit(do_action: Callable, undo_action: Callable) -> void:
	var state := Controller.state_manager.create_state_change(StateManager.StateChangeType.SONG)
	state.add_do_action(do_action)
	state.add_undo_action(undo_action)
	Controller.state_manager.commit_state_change(state)


func _snapshot_pattern(pattern: Pattern) -> Dictionary:
	var notes: Array[Vector3i] = []
	for i in pattern.note_amount:
		notes.push_back(pattern.notes[i])

	return {
		"key": pattern.key,
		"scale": pattern.scale,
		"instrument_idx": pattern.instrument_idx,
		"notes": notes,
		"record_instrument": pattern.record_instrument,
		"recorded": pattern.recorded_instrument_values.duplicate(),
	}


func _apply_pattern(pattern: Pattern, snapshot: Dictionary) -> void:
	# The note grid recenters itself when the scale signal fires, so only say what changed.
	var key_changed: bool = pattern.key != snapshot["key"]
	var scale_changed: bool = pattern.scale != snapshot["scale"]
	var instrument_changed: bool = pattern.instrument_idx != snapshot["instrument_idx"]
	var recording_changed: bool = pattern.record_instrument != snapshot["record_instrument"]

	pattern.key = snapshot["key"]
	pattern.scale = snapshot["scale"]
	pattern.instrument_idx = snapshot["instrument_idx"]
	pattern.record_instrument = snapshot["record_instrument"]
	pattern.recorded_instrument_values.assign(snapshot["recorded"])

	for i in pattern.note_amount:
		pattern.notes[i] = Vector3i(-1, 0, 0)
	pattern.note_amount = 0

	var notes: Array[Vector3i] = snapshot["notes"]
	pattern.restore_notes(notes) # Emits notes_changed.

	if key_changed:
		pattern.key_changed.emit()
	if scale_changed:
		pattern.scale_changed.emit()
	if instrument_changed:
		pattern.instrument_changed.emit()
	if recording_changed:
		pattern.instrument_recording_toggled.emit()


func _snapshot_arrangement(arrangement: Arrangement, bar_count: int) -> Dictionary:
	var bars: Array[PackedInt32Array] = []
	for i in bar_count:
		bars.push_back(arrangement.timeline_bars[i].duplicate())

	return {
		"bars": bars,
		"loop_start": arrangement.loop_start,
		"loop_end": arrangement.loop_end,
	}


func _apply_arrangement(arrangement: Arrangement, snapshot: Dictionary) -> void:
	var bars: Array[PackedInt32Array] = snapshot["bars"]
	for i in bars.size():
		arrangement.timeline_bars[i] = bars[i].duplicate()

	arrangement.update_timeline_length()
	arrangement.set_loop(snapshot["loop_start"], snapshot["loop_end"])
	arrangement.patterns_changed.emit()


# Song lifecycle.

func _show_song(song: Song, dirty: bool) -> void:
	for instrument in song.instruments:
		instrument.update_filter()

	Controller.music_player.stop_playback()
	Controller.set_current_song(song)
	# Loading a song starts playback in the app. Here it should only start when asked.
	Controller.music_player.stop_playback()

	if dirty:
		song.mark_dirty()


func _make_instrument(spec: Dictionary) -> Variant:
	var voice: Variant = _parse_voice(spec.get("voice"))
	if _is_err(voice):
		return voice

	var instrument: Instrument = Controller.instance_instrument_by_voice(voice)
	_apply_instrument_settings(instrument, spec)
	return instrument


func _apply_instrument_settings(instrument: Instrument, spec: Dictionary) -> void:
	if spec.has("volume"):
		instrument.volume = int(spec["volume"])
	if spec.has("cutoff"):
		instrument.lp_cutoff = int(spec["cutoff"])
	if spec.has("resonance"):
		instrument.lp_resonance = int(spec["resonance"])
	instrument.update_filter()


func _apply_song_settings(song: Song, params: Dictionary) -> Variant:
	if params.has("effect"):
		var effect: Variant = _parse_effect(params["effect"])
		if _is_err(effect):
			return effect
		song.global_effect = effect

	if params.has("effect_power"):
		song.global_effect_power = int(params["effect_power"])
	if params.has("bpm"):
		song.bpm = int(params["bpm"])
	if params.has("pattern_size"):
		song.pattern_size = int(params["pattern_size"])
	if params.has("bar_size"):
		song.bar_size = int(params["bar_size"])
	if params.has("swing"):
		song.swing = int(params["swing"])
	return true


## Fills a pattern from its description. Key and scale are taken as they are,
## notes are absolute pitches and aren't shifted by the key.
func _fill_pattern(pattern: Pattern, spec: Dictionary, song: Song) -> Variant:
	var index: Variant = _check_index(spec.get("instrument", 0), song.instruments.size(), "Instrument")
	if _is_err(index):
		return index

	var instrument := song.instruments[index]
	var key := 0
	var scale := 0

	if not _is_drumkit(instrument):
		var key_value: Variant = _parse_key(spec.get("key", 0))
		if _is_err(key_value):
			return key_value
		var scale_value: Variant = _parse_scale(spec.get("scale", 0))
		if _is_err(scale_value):
			return scale_value
		key = key_value
		scale = scale_value

	var notes: Variant = _parse_notes(spec.get("notes", []), key, scale, instrument, song.pattern_size)
	if _is_err(notes):
		return notes
	var check: Variant = _check_note_list(notes, instrument)
	if _is_err(check):
		return check

	pattern.instrument_idx = index
	pattern.key = key
	pattern.scale = scale

	var typed_notes: Array[Vector3i] = notes
	pattern.restore_notes(typed_notes)
	return true


## Turns [[0, 1, null], ...] into channel arrays, or an error.
func _parse_bars(raw_bars: Variant, pattern_count: int) -> Variant:
	if not raw_bars is Array:
		return _err("Bars must be a list of lists of pattern indices.")

	var bars: Array[PackedInt32Array] = []
	for bar_index in raw_bars.size():
		var raw_bar: Variant = raw_bars[bar_index]
		if not raw_bar is Array:
			return _err("Bar %d must be a list of pattern indices." % [ bar_index ])
		if raw_bar.size() > Arrangement.CHANNEL_NUMBER:
			return _err("Bar %d has %d channels, the limit is %d." % [ bar_index, raw_bar.size(), Arrangement.CHANNEL_NUMBER ])

		var channels := PackedInt32Array()
		channels.resize(Arrangement.CHANNEL_NUMBER)
		channels.fill(-1)

		for channel in raw_bar.size():
			var cell: Variant = raw_bar[channel]
			if cell == null:
				continue
			var pattern_idx := int(cell)
			if pattern_idx == -1:
				continue
			if pattern_idx < 0 || pattern_idx >= pattern_count:
				return _err("Bar %d uses pattern %d, which doesn't exist (the song has %d)." % [ bar_index, pattern_idx, pattern_count ])
			channels[channel] = pattern_idx

		bars.push_back(channels)
	return bars


func cmd_status(_params: Dictionary) -> Dictionary:
	var player: MusicPlayer = Controller.music_player
	var song: Song = Controller.current_song

	var result := {
		"version": ProjectSettings.get_setting("application/config/version"),
		"headless": _headless,
		"pid": OS.get_process_id(),
		"song": _song_summary(),
		"playback": {
			"playing": player.is_playing(),
			"stopped": player.is_stopped(),
			"bar": song.arrangement.current_bar_idx,
			"step": player.get_pattern_time(),
		},
		"can_undo": not Controller.state_manager._state_history.is_empty(),
		"can_redo": not Controller.state_manager._state_future.is_empty(),
	}
	if not _export_job.is_empty():
		result["export"] = _export_job
	return result


func cmd_create_song(params: Dictionary) -> Dictionary:
	var discard: Variant = _check_discard(params)
	if _is_err(discard):
		return discard

	var song := Song.create_default_song()
	var applied: Variant = _apply_song_settings(song, params)
	if _is_err(applied):
		return applied

	var raw_instruments: Array = params.get("instruments", [])
	if raw_instruments.size() > Song.MAX_INSTRUMENT_COUNT:
		return _err("A song can only have %d instruments." % [ Song.MAX_INSTRUMENT_COUNT ])
	if not raw_instruments.is_empty():
		song.instruments.clear()
		for spec: Variant in raw_instruments:
			var instrument: Variant = _make_instrument(spec)
			if _is_err(instrument):
				return instrument
			song.instruments.push_back(instrument)

	var raw_patterns: Array = params.get("patterns", [])
	if not raw_patterns.is_empty():
		song.patterns.clear()
		for i in raw_patterns.size():
			var pattern := Pattern.new()
			var filled: Variant = _fill_pattern(pattern, raw_patterns[i], song)
			if _is_err(filled):
				return _err("Pattern %d: %s" % [ i, filled["__error"] ])
			song.patterns.push_back(pattern)

	if params.has("bars"):
		var bars: Variant = _parse_bars(params["bars"], song.patterns.size())
		if _is_err(bars):
			return bars
		var typed_bars: Array[PackedInt32Array] = bars
		for i in typed_bars.size():
			song.arrangement.timeline_bars[i] = typed_bars[i]
		song.arrangement.update_timeline_length()

	var loop_start: int = int(params.get("loop_start", 0))
	var loop_end: int = int(params.get("loop_end", song.arrangement.timeline_length))
	if loop_start < 0 || loop_end <= loop_start || loop_end > Arrangement.BAR_NUMBER:
		return _err("The loop range %d-%d is invalid." % [ loop_start, loop_end ])
	song.arrangement.set_loop(loop_start, loop_end)

	_show_song(song, true)
	return _serialize_song(false)


func cmd_open_song(params: Dictionary) -> Dictionary:
	var path: Variant = _normalize_path(params.get("path", ""), "ceol")
	if _is_err(path):
		return path
	if not FileAccess.file_exists(path):
		return _err("No file at %s" % [ path ])
	var discard: Variant = _check_discard(params)
	if _is_err(discard):
		return discard

	var song: Song = SongLoader.load(path)
	if not song || not song.is_valid_song():
		return _err("Failed to load %s. It may be corrupt." % [ path ])

	_show_song(song, false)
	Controller.update_status("SONG LOADED", Controller.StatusLevel.SUCCESS)
	return _serialize_song(false)


func cmd_import_midi(params: Dictionary) -> Dictionary:
	var path: Variant = _normalize_path(params.get("path", ""), "mid")
	if _is_err(path):
		return path
	if not FileAccess.file_exists(path):
		return _err("No file at %s" % [ path ])
	var discard: Variant = _check_discard(params)
	if _is_err(discard):
		return discard

	var config := ImportMasterPopup.ImportConfig.new()
	config.type = ImportMasterPopup.ImportType.IMPORT_MIDI
	config.path = path
	config.pattern_size = int(params.get("pattern_size", 0))

	var song := MidiImporter.import(config)
	if not song || not song.is_valid_song():
		return _err("Failed to import %s." % [ path ])

	_show_song(song, true)
	Controller.update_status("SONG IMPORTED FROM MIDI", Controller.StatusLevel.SUCCESS)
	return _serialize_song(false)


func cmd_save_song(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var raw_path: String = str(params.get("path", ""))
	if raw_path.is_empty():
		raw_path = song.filename
	if raw_path.is_empty():
		return _err("This song has no file yet, so a path is required.")

	var path: Variant = _normalize_path(raw_path, "ceol")
	if _is_err(path):
		return path

	# Saving over the file the song came from is the normal case and needs no confirmation.
	if path != song.filename.replace("\\", "/"):
		var writable: Variant = _check_writable(path, params)
		if _is_err(writable):
			return writable

	if not SongSaver.save(song, path):
		return _err("Failed to save to %s." % [ path ])

	Controller.mark_song_saved()
	Controller.update_status("SONG SAVED", Controller.StatusLevel.SUCCESS)
	return { "file": path }


func cmd_export_song(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var format := str(params.get("format", "")).to_lower()
	var types := {
		"wav": ExportMasterPopup.ExportType.EXPORT_WAV,
		"mid": ExportMasterPopup.ExportType.EXPORT_MIDI,
		"mml": ExportMasterPopup.ExportType.EXPORT_MML,
		"xm": ExportMasterPopup.ExportType.EXPORT_XM,
	}
	if not types.has(format):
		return _err("Unknown export format '%s'. Use wav, mid, mml or xm." % [ format ])

	var path: Variant = _normalize_path(params.get("path", ""), format)
	if _is_err(path):
		return path
	var writable: Variant = _check_writable(path, params)
	if _is_err(writable):
		return writable

	var arrangement := song.arrangement
	var from_bar := int(params.get("from_bar", 0))
	var to_bar := int(params.get("to_bar", arrangement.timeline_length))
	if from_bar < 0 || to_bar <= from_bar || to_bar > arrangement.timeline_length:
		return _err("The bar range %d-%d is invalid (the song has %d bars)." % [ from_bar, to_bar, arrangement.timeline_length ])

	var config := ExportMasterPopup.ExportConfig.new()
	config.type = types[format]
	config.loop_start = from_bar
	config.loop_end = to_bar

	Controller.music_player.stop_playback()

	if format == "wav":
		return _start_wav_export(path, config)

	var success := false
	match format:
		"mid": success = MidiExporter.save(song, path, config)
		"mml": success = MMLExporter.save(song, path, config)
		"xm": success = XMExporter.save(song, path, config)

	if not success:
		return _err("Failed to export to %s." % [ path ])
	Controller.update_status("SONG EXPORTED AS %s" % [ format.to_upper() ], Controller.StatusLevel.SUCCESS)
	return { "state": "done", "path": path, "format": format }


func _start_wav_export(path: String, config: ExportMasterPopup.ExportConfig) -> Dictionary:
	var song: Song = Controller.current_song
	var arrangement := song.arrangement
	var player: MusicPlayer = Controller.music_player
	var step_seconds: float = player.get_note_time_length()
	var bars := config.loop_end - config.loop_start

	_export_job = {
		"state": "rendering",
		"path": path,
		"format": "wav",
		"song_seconds": snappedf(bars * song.pattern_size * step_seconds, 0.01),
	}

	# The app's WAV export leaves the song's loop set to the exported range.
	var loop_start := arrangement.loop_start
	var loop_end := arrangement.loop_end

	Controller.io_manager._export_wav_song_confirmed(path, config)

	# Connected after the app's own handler, which writes the file.
	player.export_ended.connect(func() -> void:
		arrangement.set_loop(loop_start, loop_end)
		player.stop_playback()

		var wrote_file := FileAccess.file_exists(path) && FileAccess.get_file_as_bytes(path).size() > 44
		_export_job["state"] = "done" if wrote_file else "failed"
	, CONNECT_ONE_SHOT)

	return _export_job


func cmd_export_status(_params: Dictionary) -> Dictionary:
	return _export_job if not _export_job.is_empty() else { "state": "idle" }


func cmd_get_song(params: Dictionary) -> Dictionary:
	return _serialize_song(params.get("include_notes", true))


func cmd_update_song(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song

	var before := {}
	for property: String in [ "bpm", "pattern_size", "bar_size", "swing", "global_effect", "global_effect_power" ]:
		before[property] = song.get(property)

	# Applying the values to a throwaway song runs the app's clamping and validates names.
	var preview := Song.new()
	for property: String in before:
		preview.set(property, before[property])
	var applied: Variant = _apply_song_settings(preview, params)
	if _is_err(applied):
		return applied

	var after := {}
	for property: String in before:
		after[property] = preview.get(property)

	var apply := func(values: Dictionary) -> void:
		for property: String in values:
			song.set(property, values[property])
		Controller.music_player.update_driver_bpm()
		Controller.music_player.update_driver_effects()
		Controller.song_sizes_changed.emit()
		Controller.song_bpm_changed.emit()
		Controller.song_effect_changed.emit()
		Controller.song_swing_changed.emit()

	_commit(apply.bind(after), apply.bind(before))

	var hidden_notes := 0
	for pattern in song.patterns:
		for i in pattern.note_amount:
			if pattern.notes[i].y >= song.pattern_size:
				hidden_notes += 1

	var result := _song_summary()
	if hidden_notes > 0:
		result["warning"] = "%d notes start past the end of the new pattern size and won't play." % [ hidden_notes ]
	return result


# Instruments.

func cmd_list_voices(params: Dictionary) -> Dictionary:
	var vm: VoiceManager = Controller.voice_manager
	var query := str(params.get("query", "")).to_lower()
	var category := str(params.get("category", "")).to_lower()

	var voices: Array[Dictionary] = []
	for voice in vm._voices:
		if not category.is_empty() && voice.category.to_lower() != category:
			continue
		if not query.is_empty() && not ("%s %s" % [ voice.category, voice.name ]).to_lower().contains(query):
			continue

		var entry := { "index": voice.index, "voice": "%s/%s" % [ voice.category, voice.name ] }
		if voice is VoiceManager.DrumkitData:
			entry["drumkit_items"] = (voice as VoiceManager.DrumkitData).items.size()
		voices.push_back(entry)

	return { "categories": Array(vm.get_categories()), "count": voices.size(), "voices": voices }


func cmd_get_drumkit(params: Dictionary) -> Dictionary:
	var voice: Variant = _parse_voice(params.get("voice"))
	if _is_err(voice):
		return voice
	if not voice is VoiceManager.DrumkitData:
		return _err("%s is not a drumkit." % [ voice.name ])

	var items: Array[Dictionary] = []
	var data := voice as VoiceManager.DrumkitData
	for i in data.items.size():
		items.push_back({ "value": i, "name": data.items[i].name })
	return { "voice": "%s/%s" % [ data.category, data.name ], "items": items }


func cmd_add_instrument(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	if song.instruments.size() >= Song.MAX_INSTRUMENT_COUNT:
		return _err("A song can only have %d instruments." % [ Song.MAX_INSTRUMENT_COUNT ])

	var voice: Variant = _parse_voice(params.get("voice"))
	if _is_err(voice):
		return voice

	var index := song.instruments.size()
	_commit(func() -> void:
		Controller.create_instrument_nocheck(voice)
		_apply_instrument_settings(song.instruments[index], params)
		Controller.song_instrument_created.emit()
	, func() -> void:
		Controller.delete_instrument_nocheck(index)
		Controller.song_instrument_changed.emit()
	)
	return _serialize_instrument(index, song.instruments[index])


func cmd_update_instrument(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var checked: Variant = _check_index(params.get("instrument"), song.instruments.size(), "Instrument")
	if _is_err(checked):
		return checked
	var index: int = checked
	var old_instrument := song.instruments[index]

	# A new voice means a new instrument object, which is also what the app does.
	var new_instrument := old_instrument
	if params.has("voice"):
		var voice: Variant = _parse_voice(params["voice"])
		if _is_err(voice):
			return voice
		new_instrument = Controller.instance_instrument_by_voice(voice)
		new_instrument.volume = old_instrument.volume
		new_instrument.lp_cutoff = old_instrument.lp_cutoff
		new_instrument.lp_resonance = old_instrument.lp_resonance

	var old_settings := { "volume": old_instrument.volume, "cutoff": old_instrument.lp_cutoff, "resonance": old_instrument.lp_resonance }
	var new_settings := old_settings.duplicate()
	for property: String in [ "volume", "cutoff", "resonance" ]:
		if params.has(property):
			new_settings[property] = int(params[property])

	# Switching to or from a drumkit changes which notes are valid in its patterns.
	var old_patterns := {}
	var new_patterns := {}
	var dropped := 0
	for pattern in song.patterns:
		if pattern.instrument_idx != index || new_instrument == old_instrument:
			continue
		old_patterns[pattern] = _snapshot_pattern(pattern)
		var preview := pattern.clone()
		dropped += preview.change_instrument(index, new_instrument).size()
		new_patterns[pattern] = _snapshot_pattern(preview)

	var apply := func(instrument: Instrument, settings: Dictionary, patterns: Dictionary) -> void:
		song.instruments[index] = instrument
		_apply_instrument_settings(instrument, settings)
		for pattern: Pattern in patterns:
			_apply_pattern(pattern, patterns[pattern])
		Controller.song_instrument_changed.emit()

	_commit(apply.bind(new_instrument, new_settings, new_patterns), apply.bind(old_instrument, old_settings, old_patterns))

	var result := _serialize_instrument(index, song.instruments[index])
	if dropped > 0:
		result["warning"] = "%d notes didn't fit the new voice and were removed. Undo restores them." % [ dropped ]
	return result


func cmd_remove_instrument(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var checked: Variant = _check_index(params.get("instrument"), song.instruments.size(), "Instrument")
	if _is_err(checked):
		return checked
	if song.instruments.size() == 1:
		return _err("A song needs at least one instrument. Change its voice with update_instrument instead.")

	var notes_before := _count_notes(song)
	Controller.delete_instrument(checked)

	var result := _song_summary()
	var dropped := notes_before - _count_notes(song)
	result["note"] = "Instrument indices after %d shifted down. Patterns that used it now use instrument 0." % [ checked ]
	if dropped > 0:
		result["warning"] = "%d notes didn't fit instrument 0 and were removed. Undo restores them." % [ dropped ]
	return result


func _count_notes(song: Song) -> int:
	var total := 0
	for pattern in song.patterns:
		total += pattern.note_amount
	return total


# Patterns.

func cmd_add_pattern(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	if song.patterns.size() >= Song.MAX_PATTERN_COUNT:
		return _err("A song can only have %d patterns." % [ Song.MAX_PATTERN_COUNT ])

	var preview := Pattern.new()
	var filled: Variant = _fill_pattern(preview, params, song)
	if _is_err(filled):
		return filled
	var snapshot := _snapshot_pattern(preview)

	var index := song.patterns.size()
	_commit(func() -> void:
		Controller.create_pattern_nocheck(snapshot["instrument_idx"])
		_apply_pattern(song.patterns[index], snapshot)
		Controller.song_pattern_created.emit()
	, func() -> void:
		Controller.delete_pattern_nocheck(index)
		Controller.song_pattern_changed.emit()
	)
	return _serialize_pattern(index, song.patterns[index], false)


func cmd_update_pattern(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var checked: Variant = _check_index(params.get("pattern"), song.patterns.size(), "Pattern")
	if _is_err(checked):
		return checked
	var index: int = checked
	var pattern := song.patterns[index]

	# Work out the result on a copy, using the same steps the app's UI uses, so
	# that a failure leaves the song untouched and the change is one undo step.
	var preview := pattern.clone()
	var dropped := 0

	if params.has("instrument"):
		var instrument_index: Variant = _check_index(params["instrument"], song.instruments.size(), "Instrument")
		if _is_err(instrument_index):
			return instrument_index
		dropped += preview.change_instrument(instrument_index, song.instruments[instrument_index]).size()

	var instrument := song.instruments[preview.instrument_idx]
	var drumkit := _is_drumkit(instrument)

	if params.has("key") && not drumkit:
		var key: Variant = _parse_key(params["key"])
		if _is_err(key):
			return key
		if params.get("transpose_with_key", true):
			preview.change_key(key)
		else:
			preview.key = key

	if params.has("scale") && not drumkit:
		var scale: Variant = _parse_scale(params["scale"])
		if _is_err(scale):
			return scale
		dropped += preview.change_scale(scale).size()

	if params.has("notes"):
		var mode := str(params.get("notes_mode", "replace"))
		var parsed: Variant = _parse_notes(params["notes"], preview.key, preview.scale, instrument, song.pattern_size)
		if _is_err(parsed):
			return parsed
		var incoming: Array[Vector3i] = parsed
		var current := _snapshot_pattern(preview)["notes"] as Array[Vector3i]
		var result_notes: Array[Vector3i] = []

		match mode:
			"replace":
				result_notes = incoming
			"add":
				result_notes.append_array(current)
				result_notes.append_array(incoming)
			"remove":
				var to_remove := {}
				for note in incoming:
					to_remove[Vector2i(note.x, note.y)] = true
				for note in current:
					if to_remove.has(Vector2i(note.x, note.y)):
						to_remove.erase(Vector2i(note.x, note.y))
					else:
						result_notes.push_back(note)
				if not to_remove.is_empty():
					var missing: PackedStringArray = []
					for note_key: Vector2i in to_remove:
						missing.push_back("%s at pos %d" % [ _note_label(note_key.x, instrument), note_key.y ])
					return _err("Couldn't find these notes to remove: %s." % [ ", ".join(missing) ])
			_:
				return _err("Unknown notes_mode '%s'. Use replace, add or remove." % [ mode ])

		var check: Variant = _check_note_list(result_notes, instrument)
		if _is_err(check):
			return check

		for i in preview.note_amount:
			preview.notes[i] = Vector3i(-1, 0, 0)
		preview.note_amount = 0
		preview.restore_notes(result_notes)

	if params.has("record_filter"):
		preview.record_instrument = params["record_filter"]

	if params.has("filter_steps"):
		for step: Variant in params["filter_steps"]:
			var position := int(step.get("pos", -1))
			if position < 0 || position >= Song.MAX_PATTERN_SIZE:
				return _err("Filter step position %d is out of range." % [ position ])
			var values := preview.recorded_instrument_values[position]
			if step.has("volume"):
				values.x = clampi(int(step["volume"]), 0, Instrument.MAX_VOLUME)
			if step.has("cutoff"):
				values.y = clampi(int(step["cutoff"]), 0, Instrument.MAX_FILTER_CUTOFF)
			if step.has("resonance"):
				values.z = clampi(int(step["resonance"]), 0, Instrument.MAX_FILTER_RESONANCE)
			preview.recorded_instrument_values[position] = values

	var before := _snapshot_pattern(pattern)
	var after := _snapshot_pattern(preview)
	_commit(_apply_pattern.bind(pattern, after), _apply_pattern.bind(pattern, before))

	var result := _serialize_pattern(index, pattern, false)
	if dropped > 0:
		result["warning"] = "%d notes didn't fit the new settings and were removed. Undo restores them." % [ dropped ]
	return result


func cmd_clone_pattern(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var checked: Variant = _check_index(params.get("pattern"), song.patterns.size(), "Pattern")
	if _is_err(checked):
		return checked
	if song.patterns.size() >= Song.MAX_PATTERN_COUNT:
		return _err("A song can only have %d patterns." % [ Song.MAX_PATTERN_COUNT ])

	var source := song.patterns[checked]
	var index := song.patterns.size()
	_commit(func() -> void:
		song.add_pattern(source.clone())
		Controller.song_pattern_created.emit()
	, func() -> void:
		Controller.delete_pattern_nocheck(index)
		Controller.song_pattern_changed.emit()
	)
	return _serialize_pattern(index, song.patterns[index], false)


func cmd_remove_pattern(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var checked: Variant = _check_index(params.get("pattern"), song.patterns.size(), "Pattern")
	if _is_err(checked):
		return checked

	Controller.delete_pattern(checked)

	var result := _song_summary()
	result["note"] = "Pattern indices after %d shifted down, in the arrangement too." % [ checked ]
	return result


# Arrangement.

func cmd_edit_arrangement(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var arrangement := song.arrangement

	var at_bar := int(params.get("at_bar", 0))
	var replace_all: bool = params.get("replace_all", false)
	var parsed: Variant = _parse_bars(params.get("bars", []), song.patterns.size())
	if _is_err(parsed):
		return parsed
	var incoming: Array[PackedInt32Array] = parsed

	if at_bar < 0 || at_bar + incoming.size() > Arrangement.BAR_NUMBER:
		return _err("The bars don't fit on the timeline, which has %d bars at most." % [ Arrangement.BAR_NUMBER ])

	var touched := maxi(arrangement.timeline_length, at_bar + incoming.size())
	var before := _snapshot_arrangement(arrangement, touched)
	var after: Dictionary = before.duplicate(true)
	var after_bars: Array[PackedInt32Array] = after["bars"]

	if replace_all:
		for i in after_bars.size():
			after_bars[i] = arrangement.create_empty_bar()

	for i in incoming.size():
		after_bars[at_bar + i] = incoming[i]

	# Unless told otherwise, the loop follows the whole song, so it all plays and exports.
	var length := 1
	for i in after_bars.size():
		for pattern_idx in after_bars[i]:
			if pattern_idx >= 0:
				length = i + 1
				break

	var loop_start := int(params.get("loop_start", 0))
	var loop_end := int(params.get("loop_end", length))
	if loop_start < 0 || loop_end <= loop_start || loop_end > Arrangement.BAR_NUMBER:
		return _err("The loop range %d-%d is invalid." % [ loop_start, loop_end ])
	after["loop_start"] = loop_start
	after["loop_end"] = loop_end

	_commit(_apply_arrangement.bind(arrangement, after), _apply_arrangement.bind(arrangement, before))
	return _song_summary()


# Playback.

func cmd_play(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song
	var arrangement := song.arrangement
	var player: MusicPlayer = Controller.music_player

	var from_bar := int(params.get("from_bar", arrangement.loop_start))
	if from_bar < arrangement.loop_start || from_bar >= arrangement.loop_end:
		return _err("Bar %d is outside the loop (%d-%d). Move the loop with edit_arrangement first." % [ from_bar, arrangement.loop_start, arrangement.loop_end ])

	player.stop_playback()
	arrangement.current_bar_idx = from_bar
	player.start_playback()

	var result := { "playing": true, "bar": from_bar, "loop_start": arrangement.loop_start, "loop_end": arrangement.loop_end }
	if _headless:
		result["warning"] = "The app is running without a window, so nothing is audible."
	return result


func cmd_pause(_params: Dictionary) -> Dictionary:
	Controller.music_player.pause_playback()
	return { "playing": false, "stopped": false }


func cmd_stop(_params: Dictionary) -> Dictionary:
	Controller.music_player.stop_playback()
	return { "playing": false, "stopped": true }


# History.

func cmd_undo(_params: Dictionary) -> Dictionary:
	if Controller.state_manager._state_history.is_empty():
		return _err("There is nothing to undo.")
	Controller.state_manager.undo_state_change()
	return _song_summary()


func cmd_redo(_params: Dictionary) -> Dictionary:
	if Controller.state_manager._state_future.is_empty():
		return _err("There is nothing to redo.")
	Controller.state_manager.do_state_change()
	return _song_summary()


# App window.

func cmd_focus(params: Dictionary) -> Dictionary:
	var song: Song = Controller.current_song

	if params.has("pattern"):
		var pattern: Variant = _check_index(params["pattern"], song.patterns.size(), "Pattern")
		if _is_err(pattern):
			return pattern
		Controller.edit_pattern(pattern)

	if params.has("instrument"):
		var instrument: Variant = _check_index(params["instrument"], song.instruments.size(), "Instrument")
		if _is_err(instrument):
			return instrument
		Controller.edit_instrument(instrument)

	if params.has("view"):
		var views := {
			"file": Menu.NavigationTarget.FILE,
			"arrangement": Menu.NavigationTarget.ARRANGEMENT,
			"instrument": Menu.NavigationTarget.INSTRUMENT,
			"advanced": Menu.NavigationTarget.ADVANCED,
		}
		var view := str(params["view"]).to_lower()
		if not views.has(view):
			return _err("Unknown view '%s'. Use file, arrangement, instrument or advanced." % [ view ])
		Controller.navigate_to(views[view])

	return { "pattern": Controller.current_pattern_index, "instrument": Controller.current_instrument_index }


func cmd_screenshot(params: Dictionary) -> Dictionary:
	if _headless:
		return _err("The app is running without a window, so there is nothing to capture.")

	var path := str(params.get("path", ""))
	var image := Controller.get_viewport().get_texture().get_image()
	if not image || image.save_png(path) != OK:
		return _err("Failed to capture the window.")
	return { "path": path, "width": image.get_width(), "height": image.get_height() }


func cmd_quit(params: Dictionary) -> Dictionary:
	var discard: Variant = _check_discard(params)
	if _is_err(discard):
		return discard

	# Deferred, so that this response still reaches the client.
	Controller.get_tree().create_timer(0.1).timeout.connect(Controller.get_tree().quit)
	return { "quitting": true }


class Client extends RefCounted:
	var peer: StreamPeerTCP = null
	var buffer: PackedByteArray = PackedByteArray()


	func _init(connection: StreamPeerTCP) -> void:
		peer = connection
