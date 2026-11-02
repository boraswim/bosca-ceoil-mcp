# Entry point passed to the stock Bosca Ceoil Blue executable with --script.
#
# This file must not reference any of the app's classes or its Controller
# autoload. Scripts given to --script are compiled before autoloads exist, and
# the app's classes depend on Controller, so a static reference here fails to
# compile. The real logic lives in bridge.gd, which is loaded once the app is up.
extends SceneTree

const MAX_BOOT_FRAMES := 2000

var _frames: int = 0
var _session_path: String = ""
var _attached: bool = false


func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--mcp-session="):
			_session_path = arg.trim_prefix("--mcp-session=")

	# --script skips the project's main scene, so we start it ourselves.
	change_scene_to_file("res://Main.tscn")


func _process(_delta: float) -> bool:
	if _attached:
		return false

	_frames += 1
	if _frames > MAX_BOOT_FRAMES:
		_attached = true
		_fail("The app did not finish starting.")
		return false

	var controller := root.get_node_or_null("Controller")
	if not controller or not current_scene or not controller.get("current_song"):
		return false

	_attached = true

	var bridge_path: String = (get_script() as Script).resource_path.get_base_dir().path_join("bridge.gd")
	var bridge_script: Variant = load(bridge_path)
	if not bridge_script or not (bridge_script as GDScript).can_instantiate():
		_fail("bridge.gd failed to compile. This version of Bosca Ceoil Blue (%s) is probably not supported." % [ ProjectSettings.get_setting("application/config/version") ])
		return false

	var bridge: Node = (bridge_script as GDScript).new()
	bridge.name = "McpBridge"
	bridge.set("session_path", _session_path)
	root.add_child(bridge)
	return false


func _fail(message: String) -> void:
	printerr("McpBridge: ", message)
	if not _session_path.is_empty():
		var file := FileAccess.open(_session_path, FileAccess.WRITE)
		if file:
			file.store_string(JSON.stringify({ "error": message, "pid": OS.get_process_id() }))
			file.close()
	quit(1)
