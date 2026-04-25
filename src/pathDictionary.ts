"use strict";

/**
 * Signal K Path Dictionary for bandwidth optimization
 * Maps common SignalK paths to short numeric IDs for transmission
 * Based on official Signal K specification: https://github.com/SignalK/specification
 */

import type { Delta, DeltaValue } from "./types";

// Path to ID mapping (encode)
export const PATH_TO_ID: Record<string, number> = {
  // Navigation paths (0x01xx)
  "navigation.position": 0x0101,
  "navigation.position.latitude": 0x0102,
  "navigation.position.longitude": 0x0103,
  "navigation.position.altitude": 0x0104,
  "navigation.courseOverGroundTrue": 0x0105,
  "navigation.courseOverGroundMagnetic": 0x0106,
  "navigation.speedOverGround": 0x0107,
  "navigation.speedThroughWater": 0x0108,
  "navigation.speedThroughWaterTransverse": 0x0109,
  "navigation.speedThroughWaterLongitudinal": 0x010a,
  "navigation.headingTrue": 0x010b,
  "navigation.headingMagnetic": 0x010c,
  "navigation.headingCompass": 0x010d,
  "navigation.magneticVariation": 0x010e,
  "navigation.magneticVariationAgeOfService": 0x010f,
  "navigation.magneticDeviation": 0x0110,
  "navigation.rateOfTurn": 0x0111,
  "navigation.attitude": 0x0112,
  "navigation.attitude.roll": 0x0113,
  "navigation.attitude.pitch": 0x0114,
  "navigation.attitude.yaw": 0x0115,
  "navigation.maneuver": 0x0116,
  "navigation.state": 0x0117,
  "navigation.log": 0x0118,
  "navigation.trip.log": 0x0119,
  "navigation.trip.lastReset": 0x011a,
  "navigation.leewayAngle": 0x011b,
  "navigation.datetime": 0x011c,
  "navigation.gnss.satellites": 0x011d,
  "navigation.gnss.antennaAltitude": 0x011e,
  "navigation.gnss.horizontalDilution": 0x011f,
  "navigation.gnss.positionDilution": 0x0120,
  "navigation.gnss.geoidalSeparation": 0x0121,
  "navigation.gnss.type": 0x0122,
  "navigation.gnss.methodQuality": 0x0123,
  "navigation.gnss.integrity": 0x0124,
  "navigation.gnss.satellitesInView": 0x0125,
  "navigation.destination.commonName": 0x0126,
  "navigation.destination.eta": 0x0127,
  "navigation.destination.waypoint": 0x0128,
  "navigation.anchor.position": 0x0129,
  "navigation.anchor.maxRadius": 0x012a,
  "navigation.anchor.currentRadius": 0x012b,
  "navigation.lights": 0x012c,
  "navigation.courseRhumbline": 0x012d,
  "navigation.courseGreatCircle": 0x012e,
  "navigation.closestApproach": 0x012f,
  "navigation.racing": 0x0130,

  // Environment paths (0x02xx)
  "environment.outside.temperature": 0x0201,
  "environment.outside.dewPointTemperature": 0x0202,
  "environment.outside.apparentWindChillTemperature": 0x0203,
  "environment.outside.theoreticalWindChillTemperature": 0x0204,
  "environment.outside.heatIndexTemperature": 0x0205,
  "environment.outside.pressure": 0x0206,
  "environment.outside.relativeHumidity": 0x0207,
  "environment.outside.airDensity": 0x0208,
  "environment.outside.illuminance": 0x0209,
  "environment.inside.temperature": 0x020a,
  "environment.inside.heatIndexTemperature": 0x020b,
  "environment.inside.pressure": 0x020c,
  "environment.inside.relativeHumidity": 0x020d,
  "environment.inside.dewPointTemperature": 0x020e,
  "environment.inside.airDensity": 0x020f,
  "environment.inside.illuminance": 0x0210,
  "environment.inside.engineRoom.temperature": 0x0211,
  "environment.inside.mainCabin.temperature": 0x0212,
  "environment.water.temperature": 0x0213,
  "environment.water.salinity": 0x0214,
  "environment.depth.belowKeel": 0x0215,
  "environment.depth.belowTransducer": 0x0216,
  "environment.depth.belowSurface": 0x0217,
  "environment.depth.transducerToKeel": 0x0218,
  "environment.depth.surfaceToTransducer": 0x0219,
  "environment.current.drift": 0x021a,
  "environment.current.setTrue": 0x021b,
  "environment.current.setMagnetic": 0x021c,
  "environment.tide.heightHigh": 0x021d,
  "environment.tide.heightNow": 0x021e,
  "environment.tide.heightLow": 0x021f,
  "environment.tide.timeLow": 0x0220,
  "environment.tide.timeHigh": 0x0221,
  "environment.wind.angleApparent": 0x0222,
  "environment.wind.angleTrueGround": 0x0223,
  "environment.wind.angleTrueWater": 0x0224,
  "environment.wind.directionChangeAlarm": 0x0225,
  "environment.wind.directionTrue": 0x0226,
  "environment.wind.directionMagnetic": 0x0227,
  "environment.wind.speedTrue": 0x0228,
  "environment.wind.speedOverGround": 0x0229,
  "environment.wind.speedApparent": 0x022a,
  "environment.heave": 0x022b,
  "environment.time": 0x022c,
  "environment.mode": 0x022d,

  // Electrical paths (0x03xx)
  "electrical.batteries.voltage": 0x0301,
  "electrical.batteries.current": 0x0302,
  "electrical.batteries.temperature": 0x0303,
  "electrical.batteries.capacity.nominal": 0x0304,
  "electrical.batteries.capacity.actual": 0x0305,
  "electrical.batteries.capacity.remaining": 0x0306,
  "electrical.batteries.capacity.stateOfCharge": 0x0307,
  "electrical.batteries.capacity.stateOfHealth": 0x0308,
  "electrical.batteries.lifetimeDischarge": 0x0309,
  "electrical.batteries.lifetimeRecharge": 0x030a,
  "electrical.batteries.chemistry": 0x030b,
  "electrical.inverters.dc": 0x030c,
  "electrical.inverters.ac": 0x030d,
  "electrical.inverters.inverterMode": 0x030e,
  "electrical.chargers.chargingAlgorithm": 0x030f,
  "electrical.chargers.chargerRole": 0x0310,
  "electrical.chargers.chargingMode": 0x0311,
  "electrical.chargers.setpointVoltage": 0x0312,
  "electrical.chargers.setpointCurrent": 0x0313,
  "electrical.alternators.revolutions": 0x0314,
  "electrical.alternators.pulleyRatio": 0x0315,
  "electrical.alternators.fieldDrive": 0x0316,
  "electrical.alternators.regulatorTemperature": 0x0317,
  "electrical.solar.controllerMode": 0x0318,
  "electrical.solar.panelVoltage": 0x0319,
  "electrical.solar.panelCurrent": 0x031a,
  "electrical.solar.panelPower": 0x031b,
  "electrical.solar.panelTemperature": 0x031c,
  "electrical.solar.yieldToday": 0x031d,
  "electrical.solar.load": 0x031e,
  "electrical.solar.loadCurrent": 0x031f,
  "electrical.ac.phase": 0x0320,

  // Propulsion paths (0x04xx)
  "propulsion.state": 0x0401,
  "propulsion.revolutions": 0x0402,
  "propulsion.temperature": 0x0403,
  "propulsion.exhaustTemperature": 0x0404,
  "propulsion.coolantTemperature": 0x0405,
  "propulsion.coolantPressure": 0x0406,
  "propulsion.oilTemperature": 0x0407,
  "propulsion.oilPressure": 0x0408,
  "propulsion.alternatorVoltage": 0x0409,
  "propulsion.runTime": 0x040a,
  "propulsion.boostPressure": 0x040b,
  "propulsion.intakeManifoldTemperature": 0x040c,
  "propulsion.engineLoad": 0x040d,
  "propulsion.engineTorque": 0x040e,
  "propulsion.transmission.gear": 0x040f,
  "propulsion.transmission.gearRatio": 0x0410,
  "propulsion.transmission.oilTemperature": 0x0411,
  "propulsion.transmission.oilPressure": 0x0412,
  "propulsion.drive.type": 0x0413,
  "propulsion.drive.trimState": 0x0414,
  "propulsion.drive.thrustAngle": 0x0415,
  "propulsion.drive.propeller.pitch": 0x0416,
  "propulsion.drive.propeller.slip": 0x0417,
  "propulsion.fuel.type": 0x0418,
  "propulsion.fuel.used": 0x0419,
  "propulsion.fuel.pressure": 0x041a,
  "propulsion.fuel.rate": 0x041b,
  "propulsion.fuel.economyRate": 0x041c,
  "propulsion.fuel.averageRate": 0x041d,

  // Steering paths (0x05xx)
  "steering.rudderAngle": 0x0501,
  "steering.rudderAngleTarget": 0x0502,
  "steering.autopilot.state": 0x0503,
  "steering.autopilot.mode": 0x0504,
  "steering.autopilot.target.windAngleApparent": 0x0505,
  "steering.autopilot.target.windAngleTrue": 0x0506,
  "steering.autopilot.target.headingTrue": 0x0507,
  "steering.autopilot.target.headingMagnetic": 0x0508,
  "steering.autopilot.deadZone": 0x0509,
  "steering.autopilot.backlash": 0x050a,
  "steering.autopilot.gain": 0x050b,
  "steering.autopilot.maxDriveCurrent": 0x050c,
  "steering.autopilot.maxDriveRate": 0x050d,
  "steering.autopilot.portLock": 0x050e,
  "steering.autopilot.starboardLock": 0x050f,

  // Tanks paths (0x06xx)
  "tanks.freshWater.currentLevel": 0x0601,
  "tanks.freshWater.currentVolume": 0x0602,
  "tanks.freshWater.capacity": 0x0603,
  "tanks.wasteWater.currentLevel": 0x0604,
  "tanks.wasteWater.currentVolume": 0x0605,
  "tanks.wasteWater.capacity": 0x0606,
  "tanks.blackWater.currentLevel": 0x0607,
  "tanks.blackWater.currentVolume": 0x0608,
  "tanks.blackWater.capacity": 0x0609,
  "tanks.fuel.currentLevel": 0x060a,
  "tanks.fuel.currentVolume": 0x060b,
  "tanks.fuel.capacity": 0x060c,
  "tanks.lubrication.currentLevel": 0x060d,
  "tanks.lubrication.currentVolume": 0x060e,
  "tanks.lubrication.capacity": 0x060f,
  "tanks.liveWell.currentLevel": 0x0610,
  "tanks.liveWell.currentVolume": 0x0611,
  "tanks.liveWell.capacity": 0x0612,
  "tanks.baitWell.currentLevel": 0x0613,
  "tanks.baitWell.currentVolume": 0x0614,
  "tanks.baitWell.capacity": 0x0615,
  "tanks.gas.currentLevel": 0x0616,
  "tanks.gas.currentVolume": 0x0617,
  "tanks.gas.capacity": 0x0618,
  "tanks.ballast.currentLevel": 0x0619,
  "tanks.ballast.currentVolume": 0x061a,
  "tanks.ballast.capacity": 0x061b,

  // Communication paths (0x07xx)
  "communication.callsignVhf": 0x0701,
  "communication.callsignHf": 0x0702,
  "communication.phoneNumber": 0x0703,
  "communication.emailHf": 0x0704,
  "communication.email": 0x0705,
  "communication.satPhoneNumber": 0x0706,
  "communication.skipperName": 0x0707,
  "communication.crewNames": 0x0708,

  // Notifications paths (0x08xx)
  "notifications.mob": 0x0801,
  "notifications.fire": 0x0802,
  "notifications.sinking": 0x0803,
  "notifications.flooding": 0x0804,
  "notifications.collision": 0x0805,
  "notifications.grounding": 0x0806,
  "notifications.listing": 0x0807,
  "notifications.adrift": 0x0808,
  "notifications.piracy": 0x0809,
  "notifications.abandon": 0x080a,

  // Design paths (0x09xx)
  "design.displacement": 0x0901,
  "design.draft.minimum": 0x0902,
  "design.draft.maximum": 0x0903,
  "design.draft.canoe": 0x0904,
  "design.length.overall": 0x0905,
  "design.length.hull": 0x0906,
  "design.length.waterline": 0x0907,
  "design.beam": 0x0908,
  "design.airHeight": 0x0909,
  "design.rigging.type": 0x090a,

  // Performance paths (0x0Axx)
  "performance.polarSpeed": 0x0a01,
  "performance.polarSpeedRatio": 0x0a02,
  "performance.velocityMadeGood": 0x0a03,
  "performance.velocityMadeGoodToWaypoint": 0x0a04,
  "performance.beatAngle": 0x0a05,
  "performance.beatAngleVelocityMadeGood": 0x0a06,
  "performance.beatAngleTargetSpeed": 0x0a07,
  "performance.gybeAngle": 0x0a08,
  "performance.gybeAngleVelocityMadeGood": 0x0a09,
  "performance.gybeAngleTargetSpeed": 0x0a0a,
  "performance.targetAngle": 0x0a0b,
  "performance.targetSpeed": 0x0a0c,
  "performance.leeway": 0x0a0d,
  "performance.tackMagnetic": 0x0a0e,
  "performance.tackTrue": 0x0a0f,

  // Sails paths (0x0Bxx)
  "sails.inventory": 0x0b01,
  "sails.area.active": 0x0b02,
  "sails.area.available": 0x0b03,
  "sails.area.total": 0x0b04,

  // Network/Modem paths (0x0Cxx)
  "networking.modem.rtt": 0x0c01,
  "networking.modem.signalStrength": 0x0c02,
  "networking.modem.connectionType": 0x0c03
};

// ID to Path mapping (decode) - generated from PATH_TO_ID.
// Both maps are frozen so that no caller can accidentally mutate the shared
// encoding/decoding tables, which would silently corrupt all path lookups.
Object.freeze(PATH_TO_ID);
export const ID_TO_PATH: Record<number, string> = Object.freeze(
  Object.fromEntries(Object.entries(PATH_TO_ID).map(([k, v]) => [v, k]))
) as Record<number, string>;

const ALL_PATHS = Object.keys(PATH_TO_ID);
const DICTIONARY_SIZE = ALL_PATHS.length;

interface PathCategory {
  name: string;
  description: string;
  icon: string;
  prefix: string;
}

// Path categories for UI grouping
export const PATH_CATEGORIES: Record<string, PathCategory> = {
  navigation: {
    name: "Navigation",
    description: "Position, speed, heading, and course data",
    icon: "🧭",
    prefix: "navigation."
  },
  environment: {
    name: "Environment",
    description: "Weather, water, wind, and depth data",
    icon: "🌊",
    prefix: "environment."
  },
  electrical: {
    name: "Electrical",
    description: "Batteries, chargers, solar, and power data",
    icon: "⚡",
    prefix: "electrical."
  },
  propulsion: {
    name: "Propulsion",
    description: "Engine, transmission, and fuel data",
    icon: "🔧",
    prefix: "propulsion."
  },
  steering: {
    name: "Steering",
    description: "Rudder and autopilot data",
    icon: "🎯",
    prefix: "steering."
  },
  tanks: {
    name: "Tanks",
    description: "Fuel, water, and fluid levels",
    icon: "🛢️",
    prefix: "tanks."
  },
  communication: {
    name: "Communication",
    description: "Vessel contact information",
    icon: "📡",
    prefix: "communication."
  },
  notifications: {
    name: "Notifications",
    description: "Alerts and emergency signals",
    icon: "🚨",
    prefix: "notifications."
  },
  design: {
    name: "Design",
    description: "Vessel dimensions and specifications",
    icon: "📐",
    prefix: "design."
  },
  performance: {
    name: "Performance",
    description: "Sailing performance metrics",
    icon: "📈",
    prefix: "performance."
  },
  sails: {
    name: "Sails",
    description: "Sail inventory and area",
    icon: "⛵",
    prefix: "sails."
  },
  networking: {
    name: "Networking",
    description: "Modem and connectivity data",
    icon: "📶",
    prefix: "networking."
  }
};

const PATHS_BY_CATEGORY: Record<string, string[]> = Object.fromEntries(
  Object.entries(PATH_CATEGORIES).map(([category, info]) => [
    category,
    ALL_PATHS.filter((path) => path.startsWith(info.prefix))
  ])
);

/**
 * Encodes a path string to its numeric ID
 * @param path - The SignalK path
 * @returns The numeric ID if found, otherwise the original path
 */
export function encodePath(path: string): number | string {
  if (PATH_TO_ID[path] !== undefined) {
    return PATH_TO_ID[path];
  }
  // No exact match -- return original path string to preserve instance IDs
  return path;
}

/**
 * Decodes a numeric ID to its path string
 * @param id - The numeric ID or original path
 * @returns The SignalK path
 */
export function decodePath(id: number | string): string {
  if (typeof id === "number" && ID_TO_PATH[id] !== undefined) {
    return ID_TO_PATH[id];
  }
  return id as string;
}

/**
 * Transforms paths in a delta object using the provided path transform function
 */
function transformDelta(
  delta: Delta,
  pathTransform: (path: string) => number | string,
  shouldTransform: (value: DeltaValue) => boolean
): Delta {
  if (!delta || !delta.updates) {
    return delta;
  }

  const transformedUpdates = new Array(delta.updates.length);
  for (let i = 0; i < delta.updates.length; i++) {
    const update = delta.updates[i];
    const values = update.values;
    let transformedValues = values;

    if (values) {
      transformedValues = new Array(values.length);
      for (let j = 0; j < values.length; j++) {
        const value = values[j];

        if (!value || typeof value !== "object") {
          transformedValues[j] = value;
        } else if (shouldTransform(value)) {
          const transformedPath = pathTransform(value.path);
          transformedValues[j] = { ...value, path: transformedPath as string };
        } else {
          transformedValues[j] = { ...value };
        }
      }
    }

    transformedUpdates[i] = {
      // Ensure source is always an object (never null/undefined)
      source: update.source ?? {},
      timestamp: update.timestamp,
      $source: update.$source,
      values: transformedValues
    };
  }

  return {
    context: delta.context,
    updates: transformedUpdates
  };
}

/**
 * Encodes paths in a delta object (optimized - no JSON stringify/parse)
 * @param delta - SignalK delta object
 * @returns Delta with encoded paths
 */
export function encodeDelta(delta: Delta): Delta {
  return transformDelta(delta, encodePath, (value) => !!value.path);
}

/**
 * Decodes paths in a delta object (optimized - no JSON stringify/parse)
 * @param delta - SignalK delta object with encoded paths
 * @returns Delta with decoded paths
 */
export function decodeDelta(delta: Delta): Delta {
  return transformDelta(delta, decodePath, (value) => value.path !== undefined);
}

/**
 * Encode the `path` field of a metadata entry using the path dictionary.
 * The `meta` payload itself is intentionally not touched — dictionary
 * compression applies to the path strings only.
 */
export function encodeMetaEntry<T extends { path: string }>(entry: T): T {
  return { ...entry, path: encodePath(entry.path) as unknown as string };
}

/**
 * Decode the `path` field of a metadata entry. Inverse of encodeMetaEntry.
 */
export function decodeMetaEntry<T extends { path: string | number }>(entry: T): T {
  return { ...entry, path: decodePath(entry.path as number | string) };
}

/**
 * Get all known paths as an array
 * @returns Array of all known SignalK paths
 */
export function getAllPaths(): string[] {
  return ALL_PATHS;
}

/**
 * Get paths by category
 * @param category - Category name (e.g., 'navigation', 'environment')
 * @returns Array of paths in that category
 */
export function getPathsByCategory(category: string): string[] {
  return PATHS_BY_CATEGORY[category] ?? [];
}

/**
 * Get the dictionary size (number of known paths)
 * @returns Number of paths in dictionary
 */
export function getDictionarySize(): number {
  return DICTIONARY_SIZE;
}
