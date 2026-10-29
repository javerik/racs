using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum GenICamNodeType
{
    NotImplemented,
    Integer,
    Float,
    String,
    Enum,
    Boolean,
    Command
}