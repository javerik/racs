use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema, strum::EnumString, strum::Display)]
pub enum GenICamNodeType {
    NotImplemented,
    Integer,
    Float,
    String,
    Enum,
    /// Read and written as `true`/`false`.
    Boolean,
    /// Not read or written: executed with `POST /devices/{id}/gc/command/{name}`.
    Command,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, strum::EnumString, strum::Display)]
pub enum GenICamVisibility {
    Beginner,
    Expert,
    Guru,
    Invisible,
    Undefined
}

impl GenICamVisibility {
    /// Map a GenICam `<Visibility>` element's text. An unrecognised value is `Undefined`;
    /// callers supply `Beginner` (the spec default) when the element is absent entirely.
    pub fn from_xml_text(text: &str) -> Self {
        match text.trim() {
            t if t.eq_ignore_ascii_case("Beginner") => GenICamVisibility::Beginner,
            t if t.eq_ignore_ascii_case("Expert") => GenICamVisibility::Expert,
            t if t.eq_ignore_ascii_case("Guru") => GenICamVisibility::Guru,
            t if t.eq_ignore_ascii_case("Invisible") => GenICamVisibility::Invisible,
            _ => GenICamVisibility::Undefined,
        }
    }
}

#[derive(Clone, Debug, Eq, Serialize, Deserialize, ToSchema, strum::EnumString, strum::Display)]
pub enum GenICamAccessMode {
    Undefined,
    ReadOnly,
    WriteOnly,
    ReadWrite,
    Unknown
}

impl PartialEq for GenICamAccessMode {
    fn eq(&self, other: &Self) -> bool {
        self.to_string() == other.to_string()
    }
}

impl GenICamAccessMode {
    /// Map a GenICam `<AccessMode>`/`<ImposedAccessMode>` element's text.
    pub fn from_xml_text(text: &str) -> Self {
        match text.trim() {
            t if t.eq_ignore_ascii_case("RO") => GenICamAccessMode::ReadOnly,
            t if t.eq_ignore_ascii_case("WO") => GenICamAccessMode::WriteOnly,
            t if t.eq_ignore_ascii_case("RW") => GenICamAccessMode::ReadWrite,
            "" => GenICamAccessMode::Undefined,
            _ => GenICamAccessMode::Unknown,
        }
    }

    pub fn is_writable(&self) -> bool {
        matches!(self, GenICamAccessMode::ReadWrite | GenICamAccessMode::WriteOnly)
    }
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct GenICamEnumInfo {
    pub display_name: String,
    pub value: i64,
    pub string_value: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct GenICamNodeInfo {
    pub name: String,
    pub display_name: String,
    pub node_type: GenICamNodeType,
    pub visibility: GenICamVisibility,
    pub access_mode: GenICamAccessMode,
    pub enums: Option<Vec<GenICamEnumInfo>>,
    /// For a selector (e.g. `GainSelector`): the features whose value depends on it, from the
    /// node's `<pSelected>` elements. Empty for every other feature.
    #[serde(default)]
    pub selected: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct GenICamNodeCategory {
    pub name: String,
    pub display_name: String,
    pub nodes: Vec<GenICamNodeInfo>
}
/// Body of `POST /devices/{id}/gc/features/state`.
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct FeatureStateRequest {
    /// Feature names, as listed by `/gc/categories`. 1 to 256 of them.
    pub names: Vec<String>,
}

/// A feature's live state: its value plus what a UI needs to offer it right now.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToSchema)]
pub struct FeatureState {
    pub name: String,
    /// `null` when the feature isn't known (see `error`).
    pub node_type: Option<GenICamNodeType>,
    /// Same format as `GET /gc/feature/{name}`. `null` for a command, a write-only feature, an
    /// unavailable one, or when the read failed (see `error`).
    pub value: Option<String>,
    /// The device's `pIsImplemented`/`pIsAvailable` conditions hold. An unavailable feature
    /// (e.g. a frame rate in a line-scan mode) can be neither read nor written.
    pub available: bool,
    /// A `pIsLocked` condition holds: the feature can be read but not written now.
    pub locked: bool,
    /// Evaluated bounds of an `Integer`/`Float` feature, when the device declares them.
    #[schema(value_type = Option<f64>)]
    pub min: Option<serde_json::Number>,
    #[schema(value_type = Option<f64>)]
    pub max: Option<serde_json::Number>,
    #[schema(value_type = Option<f64>)]
    pub inc: Option<serde_json::Number>,
    pub unit: Option<String>,
    /// GenICam `Representation`: `Linear`, `Logarithmic`, `HexNumber`, `IPV4Address`, ...
    pub representation: Option<String>,
    /// For an enum: the integer values of the entries the device currently offers. An entry
    /// listed in `/gc/categories` but missing here is not supported right now.
    pub available_entries: Option<Vec<i64>>,
    /// Why this feature's state is incomplete, e.g. `Feature not found` or a failed read.
    pub error: Option<String>,
}
