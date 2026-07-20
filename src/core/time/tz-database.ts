import tzData from "tzdata/timezone-data.json";
import { TzDatabase } from "timezonecomplete";

let initialized = false;

export function getTzDatabase(): TzDatabase {
  if (!initialized) {
    TzDatabase.init(tzData);
    initialized = true;
  }

  return TzDatabase.instance();
}
