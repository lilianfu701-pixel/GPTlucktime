export type TimePrecision = "exact" | "approximate" | "unknown";

export type CivilTimeResolution = "earlier" | "later";

export interface Birthplace {
  name: string;
  latitude: number;
  longitude: number;
}

export interface ResidenceContext {
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string;
}

export interface BirthInput {
  localDateTime: string;
  timeZone: string;
  birthplace: Birthplace;
  timePrecision?: TimePrecision;
  civilTimeResolution?: CivilTimeResolution;
  residenceContext?: ResidenceContext;
}

export type NormalizedBirthInput = Readonly<{
  localDateTime: string;
  timeZone: string;
  birthplace: Readonly<Birthplace>;
  timePrecision?: TimePrecision;
  civilTimeResolution?: CivilTimeResolution;
  residenceContext?: Readonly<ResidenceContext>;
}>;

export type InputErrorCode =
  | "INVALID_INPUT"
  | "INVALID_COORDINATES"
  | "INVALID_TIME_ZONE";

export type InputResult =
  | Readonly<{ ok: true; value: NormalizedBirthInput }>
  | Readonly<{ ok: false; code: InputErrorCode; message: string }>;
