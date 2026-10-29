//! GenICam metadata extracted from a device's XML document.
//!
//! aravis-port models the GenICam tree for *evaluation* — reading and writing feature values —
//! and deliberately doesn't carry presentation metadata like display names, visibility or
//! declared access mode. RACS's REST API exposes exactly that, so this module walks the same XML
//! document with `aravis_port::genicam::dom` and builds the metadata itself.
//!
//! The walk happens once, when a camera is connected, and the result is cached on the connection
//! (see [`crate::stores::conn_camera::CamHandle`]). That keeps `/xml` and `/gc/categories`
//! entirely free of device I/O, and means a feature get/set doesn't re-parse the document.

use std::collections::HashMap;

use aravis_port::genicam::dom::{self, XmlDom};

use crate::models::genicam_models::{
    GenICamAccessMode, GenICamEnumInfo, GenICamNodeCategory, GenICamNodeInfo, GenICamNodeType, GenICamVisibility,
};
use crate::rcs_erros::RcsError;

/// Node kinds RACS exposes as features: readable/writable values, plus `Command`s, which are
/// executed rather than read. Everything else in the document (registers backing a feature,
/// `Category`, ports) is omitted from the feature lists.
const FEATURE_TAGS: &[&str] = &[
    "Integer", "Float", "Boolean", "Command", "Enumeration", "StringReg", "String", "IntReg", "FloatReg", "Converter",
    "IntConverter", "SwissKnife", "IntSwissKnife",
];

pub struct GcMeta {
    pub xml: String,
    pub categories: Vec<GenICamNodeCategory>,
    pub nodes: HashMap<String, GenICamNodeInfo>,
}

impl GcMeta {
    /// Parse `xml` and build the category/feature metadata.
    ///
    /// `kind_of` reports what aravis-port itself made of a node name — pass
    /// `|n| camera.feature_kind(n)`. Features it can't resolve are dropped, so the API never
    /// advertises a feature that a subsequent get/set would fail on.
    pub fn from_xml(xml: String, kind_of: impl Fn(&str) -> Option<&'static str>) -> Result<Self, RcsError> {
        let doc = dom::parse(&xml).map_err(|e| RcsError::GenICamError(format!("failed to parse GenICam XML => {e}")))?;

        // Index every named element so `pFeature`/`pValue` references resolve by name. Later
        // duplicates lose to earlier ones, matching document order.
        let mut by_name: HashMap<&str, usize> = HashMap::new();
        for (idx, el) in doc.elements.iter().enumerate() {
            if let Some(name) = el.attrs.get("Name") {
                by_name.entry(name.as_str()).or_insert(idx);
            }
        }

        let mut nodes: HashMap<String, GenICamNodeInfo> = HashMap::new();
        let mut categories = Vec::new();

        // A flat scan over every `Category` element at any depth. Vendor documents nest
        // categories inside `<Group>` wrappers at varying depths, so anything that recurses on a
        // fixed step risks skipping whole levels.
        for (idx, el) in doc.elements.iter().enumerate() {
            if el.tag != "Category" {
                continue;
            }
            let Some(name) = el.attrs.get("Name") else { continue };

            let mut category_nodes = Vec::new();
            for feature_ref in doc.children_with_tag(idx, "pFeature") {
                let feature_name = doc.get(feature_ref).text.trim();
                let Some(&feature_idx) = by_name.get(feature_name) else { continue };
                let Some(info) = node_info(&doc, feature_idx, &by_name, &kind_of) else { continue };
                nodes.entry(info.name.clone()).or_insert_with(|| info.clone());
                category_nodes.push(info);
            }

            categories.push(GenICamNodeCategory {
                display_name: display_name(&doc, idx, name),
                name: name.clone(),
                nodes: category_nodes,
            });
        }

        Ok(Self { xml, categories, nodes })
    }

    pub fn feature(&self, name: &str) -> Option<&GenICamNodeInfo> {
        self.nodes.get(name)
    }
}

/// `<DisplayName>` if present, otherwise the node's `Name` — the same fallback aravis applies.
fn display_name(doc: &XmlDom, idx: usize, name: &str) -> String {
    doc.child(idx, "DisplayName")
        .map(|c| doc.get(c).text.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| name.to_string())
}

fn node_info(
    doc: &XmlDom,
    idx: usize,
    by_name: &HashMap<&str, usize>,
    kind_of: &impl Fn(&str) -> Option<&'static str>,
) -> Option<GenICamNodeInfo> {
    let el = doc.get(idx);
    let name = el.attrs.get("Name")?;
    if !FEATURE_TAGS.contains(&el.tag.as_str()) {
        return None;
    }
    // Only surface what aravis-port can actually evaluate. Without this the API would list
    // features whose get/set returns a 500.
    kind_of(name)?;

    let node_type = match el.tag.as_str() {
        "Integer" | "IntReg" | "IntConverter" | "IntSwissKnife" => GenICamNodeType::Integer,
        "Float" | "FloatReg" | "Converter" | "SwissKnife" => GenICamNodeType::Float,
        "Enumeration" => GenICamNodeType::Enum,
        "StringReg" | "String" => GenICamNodeType::String,
        "Boolean" => GenICamNodeType::Boolean,
        "Command" => GenICamNodeType::Command,
        _ => GenICamNodeType::NotImplemented,
    };

    let enums = (node_type == GenICamNodeType::Enum).then(|| enum_entries(doc, idx)).flatten();

    Some(GenICamNodeInfo {
        name: name.clone(),
        display_name: display_name(doc, idx, name),
        node_type,
        visibility: visibility(doc, idx),
        access_mode: access_mode(doc, idx, by_name),
        enums,
        selected: selected(doc, idx),
    })
}

/// The `<pSelected>` targets of a selector node, in document order.
fn selected(doc: &XmlDom, idx: usize) -> Vec<String> {
    doc.children_with_tag(idx, "pSelected")
        .into_iter()
        .map(|c| doc.get(c).text.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

/// GenICam's default visibility is `Beginner` when the element omits `<Visibility>`.
fn visibility(doc: &XmlDom, idx: usize) -> GenICamVisibility {
    doc.child(idx, "Visibility")
        .map(|c| GenICamVisibility::from_xml_text(doc.get(c).text.trim()))
        .unwrap_or(GenICamVisibility::Beginner)
}

/// The declared access mode, resolved through the `pValue` chain to whichever register actually
/// backs the feature — a `<Integer>` rarely declares `<AccessMode>` itself, its `<IntReg>` does.
///
/// This is the *declared* mode. Whether a feature is available or locked right now depends on
/// device state (`pIsImplemented`/`pIsAvailable`/`pIsLocked`), which this metadata, built once
/// without device I/O, can't know; `POST /gc/features/state` reports it live via
/// `Camera::feature_info`. Undeterminable cases default to `ReadWrite` for the same reason:
/// better to attempt and let the camera decide than to refuse a writable feature.
fn access_mode(doc: &XmlDom, idx: usize, by_name: &HashMap<&str, usize>) -> GenICamAccessMode {
    let el = doc.get(idx);
    match el.tag.as_str() {
        "SwissKnife" | "IntSwissKnife" => return GenICamAccessMode::ReadOnly,
        // A converter is only writable if it can transform a value back toward the register.
        "Converter" | "IntConverter" if doc.child(idx, "FormulaTo").is_none() => {
            return GenICamAccessMode::ReadOnly;
        }
        // A `<String>` with a literal `<Value>` rather than a `pValue` has nothing to write to.
        "String" if doc.child(idx, "pValue").is_none() => return GenICamAccessMode::ReadOnly,
        _ => {}
    }

    // An explicit `<ImposedAccessMode>` narrows whatever the backing register allows.
    let imposed = doc
        .child(idx, "ImposedAccessMode")
        .map(|c| GenICamAccessMode::from_xml_text(doc.get(c).text.trim()));
    if imposed == Some(GenICamAccessMode::ReadOnly) {
        return GenICamAccessMode::ReadOnly;
    }

    let mut current = idx;
    // Bounded to keep a malformed document with a cyclic `pValue` chain from looping forever.
    for _ in 0..16 {
        if let Some(c) = doc.child(current, "AccessMode") {
            return GenICamAccessMode::from_xml_text(doc.get(c).text.trim());
        }
        let Some(next) = doc.child(current, "pValue") else { break };
        let target = doc.get(next).text.trim();
        match by_name.get(target) {
            Some(&next_idx) if next_idx != current => current = next_idx,
            _ => break,
        }
    }

    imposed.unwrap_or(GenICamAccessMode::ReadWrite)
}

/// `<EnumEntry>` children as `(display name, integer value, symbolic name)`, mirroring the three
/// parallel lists aravis exposed.
fn enum_entries(doc: &XmlDom, idx: usize) -> Option<Vec<GenICamEnumInfo>> {
    let entries: Vec<GenICamEnumInfo> = doc
        .children_with_tag(idx, "EnumEntry")
        .into_iter()
        .filter_map(|entry_idx| {
            let entry = doc.get(entry_idx);
            let symbolic = entry.attrs.get("Name")?;
            let value_idx = doc.child(entry_idx, "Value")?;
            let value = parse_int_literal(doc.get(value_idx).text.trim())?;
            Some(GenICamEnumInfo {
                display_name: display_name(doc, entry_idx, symbolic),
                value,
                string_value: Some(symbolic.clone()),
            })
        })
        .collect();
    (!entries.is_empty()).then_some(entries)
}

/// GenICam integer literals are decimal or `0x`-prefixed hex.
fn parse_int_literal(text: &str) -> Option<i64> {
    let t = text.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).ok()
    } else {
        t.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Categories nested two levels deep inside `<Group>` wrappers, which is how vendor
    /// documents lay them out, plus a feature whose access mode lives on its backing register.
    const XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<RegisterDescription>
  <Category Name="Root">
    <pFeature>ImageFormat</pFeature>
  </Category>
  <Group Comment="outer">
    <Group Comment="inner">
      <Category Name="ImageFormat">
        <DisplayName>Image Format</DisplayName>
        <pFeature>Width</pFeature>
        <pFeature>PixelFormat</pFeature>
        <pFeature>Readonly</pFeature>
        <pFeature>ChunkModeActive</pFeature>
        <pFeature>Missing</pFeature>
        <pFeature>FirmwareTag</pFeature>
        <pFeature>UserLabel</pFeature>
        <pFeature>RegionSelector</pFeature>
        <pFeature>TriggerSoftware</pFeature>
      </Category>
      <Command Name="TriggerSoftware">
        <ImposedAccessMode>WO</ImposedAccessMode>
        <pValue>TriggerSoftwareReg</pValue>
        <CommandValue>1</CommandValue>
      </Command>
      <IntReg Name="TriggerSoftwareReg">
        <Address>0x1010</Address>
        <Length>4</Length>
        <AccessMode>WO</AccessMode>
      </IntReg>
      <Integer Name="Width">
        <DisplayName>Image Width</DisplayName>
        <Visibility>Expert</Visibility>
        <pValue>WidthReg</pValue>
      </Integer>
      <IntReg Name="WidthReg">
        <Address>0x1000</Address>
        <Length>4</Length>
        <AccessMode>RW</AccessMode>
      </IntReg>
      <Integer Name="Readonly">
        <pValue>ReadonlyReg</pValue>
      </Integer>
      <IntReg Name="ReadonlyReg">
        <Address>0x1004</Address>
        <Length>4</Length>
        <AccessMode>RO</AccessMode>
      </IntReg>
      <Enumeration Name="PixelFormat">
        <EnumEntry Name="Mono8">
          <DisplayName>Mono 8</DisplayName>
          <Value>0x01080001</Value>
        </EnumEntry>
        <EnumEntry Name="Mono12Packed">
          <Value>17825979</Value>
        </EnumEntry>
        <pValue>PixelFormatReg</pValue>
      </Enumeration>
      <IntReg Name="PixelFormatReg">
        <Address>0x1008</Address>
        <Length>4</Length>
        <AccessMode>RW</AccessMode>
      </IntReg>
      <Boolean Name="ChunkModeActive">
        <pValue>ChunkReg</pValue>
      </Boolean>
      <Enumeration Name="RegionSelector">
        <EnumEntry Name="Region0"><Value>0</Value></EnumEntry>
        <EnumEntry Name="Region1"><Value>1</Value></EnumEntry>
        <pValue>RegionSelectorReg</pValue>
        <pSelected>Width</pSelected>
        <pSelected> Readonly </pSelected>
      </Enumeration>
      <String Name="FirmwareTag">
        <Value>v1.2.3</Value>
      </String>
      <String Name="UserLabel">
        <pValue>UserLabelReg</pValue>
      </String>
      <StringReg Name="UserLabelReg">
        <Address>0x2000</Address>
        <Length>16</Length>
        <AccessMode>RW</AccessMode>
      </StringReg>
    </Group>
  </Group>
</RegisterDescription>"#;

    /// Stands in for aravis-port resolving every node except `Missing`.
    fn kind_of(name: &str) -> Option<&'static str> {
        match name {
            "Width" | "Readonly" => Some("Integer"),
            "PixelFormat" | "RegionSelector" => Some("Enumeration"),
            "ChunkModeActive" => Some("Boolean"),
            "TriggerSoftware" => Some("Command"),
            "FirmwareTag" | "UserLabel" => Some("String"),
            _ => None,
        }
    }

    fn meta() -> GcMeta {
        GcMeta::from_xml(XML.to_string(), kind_of).expect("parse failed")
    }

    #[test]
    fn finds_categories_nested_at_any_depth() {
        let meta = meta();
        let names: Vec<&str> = meta.categories.iter().map(|c| c.name.as_str()).collect();
        // "ImageFormat" sits two `<Group>` levels below the root; a walk that recurses by a
        // fixed step would skip it entirely.
        assert!(names.contains(&"Root"), "got {names:?}");
        assert!(names.contains(&"ImageFormat"), "got {names:?}");
    }

    #[test]
    fn category_display_name_falls_back_to_name() {
        let meta = meta();
        let image_format = meta.categories.iter().find(|c| c.name == "ImageFormat").unwrap();
        assert_eq!(image_format.display_name, "Image Format");
        let root = meta.categories.iter().find(|c| c.name == "Root").unwrap();
        assert_eq!(root.display_name, "Root");
    }

    #[test]
    fn feature_metadata_is_read_from_the_document() {
        let meta = meta();
        let width = meta.feature("Width").expect("Width missing");
        assert_eq!(width.display_name, "Image Width");
        assert_eq!(width.node_type, GenICamNodeType::Integer);
        assert!(matches!(width.visibility, GenICamVisibility::Expert));
        // Declared on the backing IntReg, not on the Integer itself.
        assert_eq!(width.access_mode, GenICamAccessMode::ReadWrite);
    }

    #[test]
    fn visibility_defaults_to_beginner_when_absent() {
        let meta = meta();
        let readonly = meta.feature("Readonly").unwrap();
        assert!(matches!(readonly.visibility, GenICamVisibility::Beginner));
    }

    #[test]
    fn access_mode_follows_the_pvalue_chain() {
        let meta = meta();
        assert_eq!(meta.feature("Readonly").unwrap().access_mode, GenICamAccessMode::ReadOnly);
    }

    #[test]
    fn enum_entries_carry_symbolic_names_and_hex_values() {
        let meta = meta();
        let pf = meta.feature("PixelFormat").unwrap();
        assert_eq!(pf.node_type, GenICamNodeType::Enum);
        let enums = pf.enums.as_ref().expect("expected enum entries");
        assert_eq!(enums.len(), 2);
        let mono8 = enums.iter().find(|e| e.string_value.as_deref() == Some("Mono8")).unwrap();
        assert_eq!(mono8.value, 0x0108_0001);
        assert_eq!(mono8.display_name, "Mono 8");
        // No <DisplayName>, so it falls back to the symbolic name.
        let packed = enums.iter().find(|e| e.string_value.as_deref() == Some("Mono12Packed")).unwrap();
        assert_eq!(packed.display_name, "Mono12Packed");
        assert_eq!(packed.value, 17_825_979);
    }

    #[test]
    fn string_nodes_are_features_and_a_literal_one_is_read_only() {
        let meta = meta();
        let literal = meta.feature("FirmwareTag").expect("FirmwareTag missing");
        assert_eq!(literal.node_type, GenICamNodeType::String);
        assert_eq!(literal.access_mode, GenICamAccessMode::ReadOnly);
        // Writable through its pValue, down to the StringReg's declared access mode.
        let backed = meta.feature("UserLabel").expect("UserLabel missing");
        assert_eq!(backed.node_type, GenICamNodeType::String);
        assert_eq!(backed.access_mode, GenICamAccessMode::ReadWrite);
    }

    #[test]
    fn a_selector_lists_the_features_it_selects() {
        let meta = meta();
        assert_eq!(meta.feature("RegionSelector").unwrap().selected, ["Width", "Readonly"]);
        assert!(meta.feature("Width").unwrap().selected.is_empty());
    }

    #[test]
    fn unresolvable_and_non_feature_nodes_are_omitted() {
        let meta = meta();
        // Referenced by the category but absent from the document.
        assert!(meta.feature("Missing").is_none());
        // Backing registers are not features in their own right.
        assert!(meta.feature("WidthReg").is_none());
        assert!(meta.feature("TriggerSoftwareReg").is_none());
    }

    #[test]
    fn booleans_and_commands_are_features() {
        let meta = meta();
        let chunk = meta.feature("ChunkModeActive").expect("Boolean missing");
        assert_eq!(chunk.node_type, GenICamNodeType::Boolean);
        assert_eq!(chunk.access_mode, GenICamAccessMode::ReadWrite);
        let trigger = meta.feature("TriggerSoftware").expect("Command missing");
        assert_eq!(trigger.node_type, GenICamNodeType::Command);
        assert_eq!(trigger.access_mode, GenICamAccessMode::WriteOnly);
        assert!(trigger.enums.is_none());
    }

    #[test]
    fn xml_is_retained_verbatim() {
        assert_eq!(meta().xml, XML);
    }
}
