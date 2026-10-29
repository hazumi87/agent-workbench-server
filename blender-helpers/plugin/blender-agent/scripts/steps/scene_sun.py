"""scene_sun — SAVE a geographic sun in the scene: a Sun light and a Nishita sky placed from latitude / longitude / date / local time and the true compass bearing of the model's axes. Render-only: the rig carries blender_agent_marker, so export_scene and the other exporters never write it (the app GLB keeps only its own lights). Saves a checkpoint (not with dry_run).

How: standard NOAA solar-position formulas (accurate to a fraction of a degree) give the sun's azimuth (true bearing, clockwise from north) and geometric elevation at the UTC instant. The model is turned to the compass by `house_bearing_deg` = the true bearing of the direction named by `house_side` (default "-Y": the house wall faces/lies toward -Y), so for "-Y" the world +Y bearing is that plus 180 (house toward 0 deg = -Y at 0, +Y at 180, +X at 270, -X at 90). The sun lamp then points along the light's travel direction; the sky texture gets the same elevation and rotation. Local time uses the IANA zone's own rules, so daylight saving follows the date (PDT in summer, PST in winter). Re-running REPLACES the rig; any setting left out is taken from the saved rig, so a new date or time is `{"date": "", "time": "12:00"}`.
params:
  lat, lon      degrees, north / east positive (e.g. 45.0, -122.0). Required the first time.
  tz            IANA zone (default "America/Los_Angeles").
  date, time    local calendar date "YYYY-MM-DD" and local time "HH:MM" (or "HH:MM:SS"); OR `utc` "YYYY-MM-DDTHH:MM:SS" (then date / time are ignored).
  house_bearing_deg  true bearing (0 = north, 90 = east) that points from the middle of the model TOWARD the house (the direction `house_side`). Required the first time. Give its provenance in `bearing_source` (free text) and `bearing_verified` (bool, default false): both are stored and reported.
  house_side    "-Y" (default) | "+Y" | "+X" | "-X": the model direction that `house_bearing_deg` describes.
  strength      sun lamp strength in W/m2 (default 3.0, the same default as kit2_view's own sun); `angle_deg` the disc size (default 0.53). Below the horizon the strength is stored as 0 and the sky still follows.
  enabled       true (default) | false: switch the sun OFF (lamp 0, sky dark) but keep the saved place / date / orientation, e.g. for a night render; set it true again to bring the same sun back.
  sky           true (default): also set a Nishita sky World ("SolarSky") on the scene (the old world stays in the file, unused); false: lamp only.
  air, dust, ozone  optional Nishita sky values (defaults 1.0, 1.0, 1.0).
  dry_run       true: compute and report only; nothing is made or saved.
Returns: `utc`, `local` (with `utc_offset_h` and `dst`), `azimuth_deg` (true bearing of the sun), `elevation_deg`, `below_horizon`, `sun_direction_world` (unit vector from the model TOWARD the sun), `light_travel_world`, `world_bearings` (true bearing of +X, +Y, -X, -Y), the stored provenance, the object names, `previous` (the rig it replaced, if any).
Limits: no atmospheric refraction in the placement (about 0.5 degree at the horizon); the sky is Cycles only (Workbench and the glTF ignore it); night skies are dark, not star-lit.
Read it back with `kit2_view` `"use_saved_sun": true` (renders with this rig instead of its temporary sun and world).
"""
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402

SUN = "Solar_Sun"
COLL = "SolarRig"
SKY = "SolarSky"
MARK = "blender_agent_marker"
SIDE_BEARING_OFFSET = {"-Y": 180.0, "+Y": 0.0, "+X": -90.0, "-X": 90.0}  # bearing of world +Y = house_bearing + offset (mod 360)


def _tz(name):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception as e:  # no tz database in this Python: only the zone's US rules are known here
        if name != "America/Los_Angeles":
            raise RuntimeError(f"tz {name!r}: no time-zone database in this Blender ({e}); give `utc` instead") from e
        return None


def _la_offset(naive):
    """US Pacific rules (2007 on): DST from the 2nd Sunday of March 02:00 to the 1st Sunday of November 02:00."""
    def nth_sunday(y, m, n):
        d = datetime(y, m, 1)
        d += timedelta(days=(6 - d.weekday()) % 7)
        return d + timedelta(days=7 * (n - 1))
    s = nth_sunday(naive.year, 3, 2).replace(hour=2)
    e = nth_sunday(naive.year, 11, 1).replace(hour=2)
    return (-7, True) if s <= naive < e else (-8, False)


def to_utc(date, time, tzname):
    naive = datetime.fromisoformat(f"{date}T{time}")
    tz = _tz(tzname)
    if tz is not None:
        loc = naive.replace(tzinfo=tz)
        off = loc.utcoffset()
        return loc.astimezone(timezone.utc), off.total_seconds() / 3600, bool(loc.dst())
    off, dst = _la_offset(naive)
    return (naive - timedelta(hours=off)).replace(tzinfo=timezone.utc), off, dst


def sun_position(utc, lat, lon):
    """NOAA solar position: (azimuth deg clockwise from north, geometric elevation deg)."""
    jd = (utc - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / 86400.0 + 2451545.0
    T = (jd - 2451545.0) / 36525.0
    r = math.radians
    L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    C = (math.sin(r(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) + math.sin(r(2 * M)) * (0.019993 - 0.000101 * T) + math.sin(r(3 * M)) * 0.000289)
    om = 125.04 - 1934.136 * T
    lam = L0 + C - 0.00569 - 0.00478 * math.sin(r(om))
    eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * math.cos(r(om))
    decl = math.asin(math.sin(r(eps)) * math.sin(r(lam)))
    y = math.tan(r(eps / 2)) ** 2
    eqt = 4 * math.degrees(y * math.sin(2 * r(L0)) - 2 * e * math.sin(r(M)) + 4 * e * y * math.sin(r(M)) * math.cos(2 * r(L0))
                           - 0.5 * y * y * math.sin(4 * r(L0)) - 1.25 * e * e * math.sin(2 * r(M)))
    mins = utc.hour * 60 + utc.minute + utc.second / 60.0
    ha = ((mins + eqt + 4 * lon) % 1440) / 4 - 180
    la = r(lat)
    cz = math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(r(ha))
    el = 90 - math.degrees(math.acos(max(-1, min(1, cz))))
    az = (math.degrees(math.atan2(math.sin(r(ha)), math.cos(r(ha)) * math.sin(la) - math.tan(decl) * math.cos(la))) + 180) % 360
    return az, el


def world_dir(bearing_deg, elev_deg, y_bearing):
    d = math.radians(bearing_deg - y_bearing)  # clockwise from +Y, seen from above
    ce = math.cos(math.radians(elev_deg))
    return Vector((math.sin(d) * ce, math.cos(d) * ce, math.sin(math.radians(elev_deg))))


def saved_rig():
    o = bpy.data.objects.get(SUN)
    if o and "solar" in o:
        return json.loads(o["solar"])
    return None


def main():
    prev = saved_rig()
    base = dict((prev or {}).get("settings") or {})
    for k in ("lat", "lon", "tz", "date", "time", "utc", "house_bearing_deg", "house_side", "bearing_source", "bearing_verified", "strength", "angle_deg", "sky", "air", "dust", "ozone", "enabled"):
        if k in L.PARAMS:
            base[k] = L.PARAMS[k]
    if "utc" in L.PARAMS:
        base.pop("date", None)
        base.pop("time", None)
    elif "date" in L.PARAMS or "time" in L.PARAMS:
        base.pop("utc", None)
    s = base
    for k in ("lat", "lon", "house_bearing_deg"):
        if s.get(k) is None:
            raise RuntimeError(f"{k}: required the first time (no saved rig to take it from)")
    lat, lon = float(s["lat"]), float(s["lon"])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise RuntimeError("lat in -90..90, lon in -180..180")
    tzname = s.get("tz", "America/Los_Angeles")
    side = s.get("house_side", "-Y")
    if side not in SIDE_BEARING_OFFSET:
        raise RuntimeError('house_side: "-Y" | "+Y" | "+X" | "-X"')
    if s.get("utc"):
        utc = datetime.fromisoformat(str(s["utc"]).replace("Z", "")).replace(tzinfo=timezone.utc)
        loc = {"utc_offset_h": None, "dst": None, "note": "given as UTC"}
    else:
        if not s.get("date") or not s.get("time"):
            raise RuntimeError("date and time (local, in tz) or utc are required")
        utc, off, dst = to_utc(s["date"], s["time"], tzname)
        loc = {"date": s["date"], "time": s["time"], "tz": tzname, "utc_offset_h": off, "dst": dst}
    y_bearing = (float(s["house_bearing_deg"]) + SIDE_BEARING_OFFSET[side]) % 360
    az, el = sun_position(utc, lat, lon)
    sd = world_dir(az, el, y_bearing)
    below = el <= 0
    on = bool(s.get("enabled", True))
    strength = 0.0 if (below or not on) else float(s.get("strength", 3.0))
    report = {"dry_run": bool(L.param("dry_run", False)), "utc": utc.strftime("%Y-%m-%dT%H:%M:%SZ"), "local": loc, "azimuth_deg": round(az, 3), "elevation_deg": round(el, 3), "below_horizon": below,
              "sun_direction_world": [round(x, 5) for x in sd], "light_travel_world": [round(-x, 5) for x in sd],
              "world_bearings": {"+X": round((y_bearing + 90) % 360, 2), "+Y": round(y_bearing, 2), "-X": round((y_bearing + 270) % 360, 2), "-Y": round((y_bearing + 180) % 360, 2)},
              "provenance": {"lat": lat, "lon": lon, "tz": tzname, "house_side": side, "house_bearing_deg": float(s["house_bearing_deg"]), "bearing_source": s.get("bearing_source"), "bearing_verified": bool(s.get("bearing_verified", False))},
              "strength_stored": strength, "previous": (prev or {}).get("result")}
    report["enabled"] = on
    if not on:
        report["note"] = "enabled false: lamp strength 0 and the sky dark (the rig and its date / place stay saved); set enabled true to bring the sun back"
    elif below:
        report["note"] = "the sun is below the horizon at this instant: lamp strength stored as 0"
    if L.param("dry_run", False):
        L.finish(report, save=False)
        return
    scn = bpy.context.scene
    old = bpy.data.objects.get(SUN)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    ld = bpy.data.lights.get(SUN) or bpy.data.lights.new(SUN, "SUN")
    ld.type = "SUN"
    ld.energy = strength
    ld.angle = math.radians(float(s.get("angle_deg", 0.53)))
    sun = bpy.data.objects.new(SUN, ld)
    sun.rotation_euler = (-sd).to_track_quat("-Z", "Y").to_euler()
    coll = bpy.data.collections.get(COLL) or bpy.data.collections.new(COLL)
    if coll.name not in scn.collection.children:
        scn.collection.children.link(coll)
    coll.objects.link(sun)
    sun[MARK] = "render-only solar rig: never exported"
    stored = {k: v for k, v in s.items()}
    report.pop("previous", None)
    sun["solar"] = json.dumps({"settings": stored, "result": {k: report[k] for k in ("utc", "azimuth_deg", "elevation_deg", "below_horizon")}})
    if s.get("sky", True):
        w = bpy.data.worlds.get(SKY) or bpy.data.worlds.new(SKY)
        w.use_nodes = True
        nt = w.node_tree
        nt.nodes.clear()
        sk = nt.nodes.new("ShaderNodeTexSky")
        sk.sky_type = "NISHITA"
        sk.sun_disc = False  # the lamp is the direct sun; the sky gives the dome only
        sk.sun_elevation = math.radians(max(el, -5.0))
        sk.sun_rotation = math.radians(0.0)  # set below by measurement-checked convention
        sk.air_density = float(s.get("air", 1.0))
        sk.dust_density = float(s.get("dust", 1.0))
        sk.ozone_density = float(s.get("ozone", 1.0))
        sk.sun_rotation = _sky_rotation(sd)
        bg = nt.nodes.new("ShaderNodeBackground")
        bg.inputs["Strength"].default_value = 1.0 if on else 0.0
        out = nt.nodes.new("ShaderNodeOutputWorld")
        nt.links.new(sk.outputs["Color"], bg.inputs["Color"])
        nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
        scn.world = w
        report["sky"] = {"world": SKY, "sun_elevation_deg": round(math.degrees(sk.sun_elevation), 3), "sun_rotation_rad": round(sk.sun_rotation, 5)}
    report["objects"] = {"sun": SUN, "collection": COLL, "marker": "render-only (not exported)"}
    L.finish(report, save=True)


def _sky_rotation(sd):
    """Blender's Nishita sky puts the sun at azimuth (pi/2 - sun_rotation) measured from +X towards +Y: the same reading as atan2 on the world direction.
    (Checked by a panorama render in the dev tests: the brightest pixel direction matches the lamp direction.)"""
    return (math.pi / 2 - math.atan2(sd.y, sd.x)) % (2 * math.pi)


if __name__ == "__main__":
    L.run(main)
