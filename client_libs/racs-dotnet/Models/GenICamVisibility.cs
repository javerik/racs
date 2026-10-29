using System.Text.Json.Serialization;

namespace Racs.Dotnet.Models;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum GenICamVisibility
{
    Beginner,
    Expert,
    Guru,
    Invisible,
    Undefined
}