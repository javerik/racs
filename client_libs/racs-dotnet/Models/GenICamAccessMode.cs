using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum GenICamAccessMode
{
    Undefined,

    ReadOnly,

    WriteOnly,

    ReadWrite,

    Unknown
}