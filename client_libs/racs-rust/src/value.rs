//! Typed GenICam feature values.

use crate::error::{Error, Result};
use crate::models::{FeatureState, GenICamNodeType};

/// A feature value, typed by the feature's node type.
#[derive(Debug, Clone, PartialEq)]
pub enum FeatureValue {
    /// Integer and Enum features. The server reads enums as their integer value.
    Int(i64),
    Float(f64),
    Bool(bool),
    String(String),
    /// A command, or a feature that is unavailable right now.
    None,
}

impl FeatureValue {
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            FeatureValue::Int(v) => Some(*v),
            _ => None,
        }
    }

    /// Float features, and Integer features widened.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            FeatureValue::Float(v) => Some(*v),
            FeatureValue::Int(v) => Some(*v as f64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            FeatureValue::Bool(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            FeatureValue::String(v) => Some(v),
            _ => None,
        }
    }

    pub fn is_none(&self) -> bool {
        matches!(self, FeatureValue::None)
    }
}

impl FeatureState {
    /// The value parsed by node type. Errors for an unknown feature or a failed read.
    pub fn typed_value(&self) -> Result<FeatureValue> {
        if let Some(error) = &self.error {
            return Err(Error::feature(&self.name, error.clone()));
        }
        let Some(value) = &self.value else {
            return Ok(FeatureValue::None);
        };
        let invalid = |e: &dyn std::fmt::Display| Error::feature(&self.name, format!("cannot parse {value:?}: {e}"));
        Ok(match self.node_type {
            Some(GenICamNodeType::Integer | GenICamNodeType::Enum) => {
                FeatureValue::Int(value.parse().map_err(|e| invalid(&e))?)
            }
            Some(GenICamNodeType::Float) => FeatureValue::Float(value.parse().map_err(|e| invalid(&e))?),
            Some(GenICamNodeType::Boolean) => FeatureValue::Bool(value.eq_ignore_ascii_case("true")),
            _ => FeatureValue::String(value.clone()),
        })
    }
}

/// Types a feature value can be read as with [`Camera::get`](crate::Camera::get).
///
/// Integers read Integer and Enum features, floats read Float (and Integer) features, `bool`
/// reads Boolean, `String` reads anything as text. `Option<T>` gives `None` for a feature without
/// a value instead of an error.
pub trait FromFeatureValue: Sized {
    fn from_feature_value(name: &str, value: FeatureValue) -> Result<Self>;
}

fn mismatch(name: &str, wanted: &str, value: &FeatureValue) -> Error {
    match value {
        FeatureValue::None => Error::feature(name, "no value: a command, or not available now"),
        other => Error::feature(name, format!("{other:?} is not {wanted}")),
    }
}

impl FromFeatureValue for FeatureValue {
    fn from_feature_value(_: &str, value: FeatureValue) -> Result<Self> {
        Ok(value)
    }
}

impl<T: FromFeatureValue> FromFeatureValue for Option<T> {
    fn from_feature_value(name: &str, value: FeatureValue) -> Result<Self> {
        match value {
            FeatureValue::None => Ok(None),
            value => T::from_feature_value(name, value).map(Some),
        }
    }
}

macro_rules! from_int {
    ($($t:ty),*) => {$(
        impl FromFeatureValue for $t {
            fn from_feature_value(name: &str, value: FeatureValue) -> Result<Self> {
                let v = value.as_i64().ok_or_else(|| mismatch(name, stringify!($t), &value))?;
                <$t>::try_from(v).map_err(|_| Error::feature(name, format!("{v} does not fit {}", stringify!($t))))
            }
        }
    )*};
}
from_int!(i64, i32, i16, i8, u64, u32, u16, u8, usize);

impl FromFeatureValue for f64 {
    fn from_feature_value(name: &str, value: FeatureValue) -> Result<Self> {
        value.as_f64().ok_or_else(|| mismatch(name, "f64", &value))
    }
}

impl FromFeatureValue for f32 {
    fn from_feature_value(name: &str, value: FeatureValue) -> Result<Self> {
        f64::from_feature_value(name, value).map(|v| v as f32)
    }
}

impl FromFeatureValue for bool {
    fn from_feature_value(name: &str, value: FeatureValue) -> Result<Self> {
        value.as_bool().ok_or_else(|| mismatch(name, "bool", &value))
    }
}

impl FromFeatureValue for String {
    fn from_feature_value(name: &str, value: FeatureValue) -> Result<Self> {
        match value {
            FeatureValue::String(v) => Ok(v),
            FeatureValue::Int(v) => Ok(v.to_string()),
            FeatureValue::Float(v) => Ok(v.to_string()),
            FeatureValue::Bool(v) => Ok(v.to_string()),
            FeatureValue::None => Err(mismatch(name, "String", &value)),
        }
    }
}

/// Values [`Camera::set`](crate::Camera::set) can write, formatted as the server parses them.
pub trait IntoFeatureValue {
    fn into_feature_string(self) -> String;
}

macro_rules! into_display {
    ($($t:ty),*) => {$(
        impl IntoFeatureValue for $t {
            fn into_feature_string(self) -> String {
                self.to_string()
            }
        }
    )*};
}
into_display!(i64, i32, i16, i8, u64, u32, u16, u8, usize, f64, f32, String, &str, &String);

impl IntoFeatureValue for bool {
    fn into_feature_string(self) -> String {
        if self { "true" } else { "false" }.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(node_type: Option<GenICamNodeType>, value: Option<&str>, error: Option<&str>) -> FeatureState {
        FeatureState {
            name: "F".into(),
            node_type,
            value: value.map(Into::into),
            available: true,
            locked: false,
            min: None,
            max: None,
            inc: None,
            unit: None,
            representation: None,
            available_entries: None,
            error: error.map(Into::into),
        }
    }

    #[test]
    fn values_are_typed_by_node_type() {
        use GenICamNodeType::*;
        assert_eq!(state(Some(Integer), Some("64"), None).typed_value().unwrap(), FeatureValue::Int(64));
        assert_eq!(state(Some(Enum), Some("3"), None).typed_value().unwrap(), FeatureValue::Int(3));
        assert_eq!(state(Some(Float), Some("1234"), None).typed_value().unwrap(), FeatureValue::Float(1234.0));
        assert_eq!(state(Some(Boolean), Some("true"), None).typed_value().unwrap(), FeatureValue::Bool(true));
        assert_eq!(state(Some(String), Some("abc"), None).typed_value().unwrap(), FeatureValue::String("abc".into()));
        assert_eq!(state(Some(Command), None, None).typed_value().unwrap(), FeatureValue::None);
        assert!(matches!(state(None, None, Some("Feature not found")).typed_value(), Err(Error::Feature { .. })));
    }

    #[test]
    fn conversions_check_the_type() {
        assert_eq!(u32::from_feature_value("W", FeatureValue::Int(64)).unwrap(), 64);
        assert!(u8::from_feature_value("W", FeatureValue::Int(300)).is_err());
        assert_eq!(f64::from_feature_value("E", FeatureValue::Int(5)).unwrap(), 5.0);
        assert!(bool::from_feature_value("B", FeatureValue::Int(1)).is_err());
        assert!(i64::from_feature_value("C", FeatureValue::None).is_err());
        assert_eq!(Option::<i64>::from_feature_value("C", FeatureValue::None).unwrap(), None);
        assert_eq!(String::from_feature_value("W", FeatureValue::Int(64)).unwrap(), "64");
    }

    #[test]
    fn values_are_written_as_the_server_parses_them() {
        assert_eq!(true.into_feature_string(), "true");
        assert_eq!(640.into_feature_string(), "640");
        assert_eq!(2500.0.into_feature_string(), "2500");
        assert_eq!(2.5.into_feature_string(), "2.5");
        assert_eq!("Mono8".into_feature_string(), "Mono8");
    }
}
