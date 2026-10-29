// See https://aka.ms/new-console-template for more information


using Racs.Dotnet;
using Racs.Dotnet.Models;

Console.WriteLine("C# Example using racs server");
await using var client = new RacsClient("http://localhost:8742");


var devices = await client.GetDevicesAsync();

if (!devices.Available.Any())
{
    Console.WriteLine("No available devices");
    Environment.Exit(1);
}

devices.Available.ForEach(d =>
{
    Console.WriteLine($"Found device: {d.Model} -  {d.Ip}:{d.Mac}");
});

Console.WriteLine("Connect to first device and try to fetch an image");

var cam = await client.ConnectAsync(devices.Available.First().Id);
Console.WriteLine($"Resolution: {await cam.GetAsync<int>("Width")}x{await cam.GetAsync<int>("Height")}");

var image = await cam.GrabJpegAsync();
await File.WriteAllBytesAsync("image.jpg", image);
Console.WriteLine("Image saved to image.jpg");

Console.WriteLine("Reading 10 raw frames from the live stream");
await using (var live = await cam.OpenLiveStreamAsync(new LiveStreamOptions { Format = ImageFormat.Raw }))
{
    var count = 0;
    await foreach (var frame in live.ReadFramesAsync())
    {
        var pixels = frame.ToUInt16Array();
        Console.WriteLine($"Frame {frame.FrameNumber}: {frame.Width}x{frame.Height}, mean {pixels.Average(p => p):F1}");
        if (++count == 10)
        {
            break;
        }
    }
}

await cam.DisconnectAsync();
Console.WriteLine("Disconnecting from device");
