using System.Buffers.Binary;
using Racs.Dotnet.Models;
using ZstdSharp;

namespace Racs.Dotnet;

/// <summary>
/// One image, with what it takes to decode it. For <see cref="ImageFormat.Raw"/>, <see cref="Data"/> is
/// Width*Height pixels row by row: one byte each at a <see cref="BitDepth"/> of 8, otherwise a little-endian
/// ushort each in the range 0..2^BitDepth. For <see cref="ImageFormat.Zstd"/> it is those pixels losslessly
/// compressed, which <see cref="ToUInt16Array"/> and <see cref="ToRaw"/> decode. For <see cref="ImageFormat.Jpeg"/>
/// it is a JPEG file.
/// </summary>
public sealed class Frame
{
    public required byte[] Data { get; init; }

    public required int Width { get; init; }

    public required int Height { get; init; }

    public ImageFormat Format { get; init; } = ImageFormat.Raw;

    public string PixelFormat { get; init; } = "Mono8";

    public int BitDepth { get; init; } = 8;

    /// <summary>Live stream only: the message number in the session.</summary>
    public uint? FrameNumber { get; init; }

    /// <summary>Live stream only: frames dropped so far in the session.</summary>
    public uint? Dropped { get; init; }

    public int BytesPerPixel => BitDepth > 8 ? 2 : 1;

    /// <summary>
    /// The pixels as one ushort each, row by row. 8-bit pixels are widened. A zstd frame is decoded first.
    /// </summary>
    public ushort[] ToUInt16Array()
    {
        var data = Format switch
        {
            ImageFormat.Raw => Data,
            ImageFormat.Zstd => DecodeZstd(),
            _ => throw new InvalidOperationException(
                $"ToUInt16Array needs a raw or zstd frame, this one is {Format}; decode Data instead."),
        };

        var pixels = Width * Height;
        if (data.Length != pixels * BytesPerPixel)
        {
            throw new InvalidOperationException(
                $"Frame holds {data.Length} bytes, {Width}x{Height} at {BitDepth} bit needs {pixels * BytesPerPixel}.");
        }

        var result = new ushort[pixels];
        if (BytesPerPixel == 1)
        {
            for (var i = 0; i < pixels; i++)
            {
                result[i] = data[i];
            }
        }
        else
        {
            for (var i = 0; i < pixels; i++)
            {
                result[i] = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(i * 2, 2));
            }
        }

        return result;
    }

    /// <summary>This frame with raw pixels: a zstd frame decoded, a raw one as it is.</summary>
    public Frame ToRaw() => Format switch
    {
        ImageFormat.Raw => this,
        ImageFormat.Zstd => new Frame
        {
            Data = DecodeZstd(),
            Width = Width,
            Height = Height,
            Format = ImageFormat.Raw,
            PixelFormat = PixelFormat,
            BitDepth = BitDepth,
            FrameNumber = FrameNumber,
            Dropped = Dropped,
        },
        _ => throw new InvalidOperationException($"ToRaw needs a raw or zstd frame, this one is {Format}."),
    };

    /// <summary>
    /// The raw bytes of a zstd frame. It decompresses to a residual per pixel: the pixel minus the one above it
    /// (minus 0 in the first row), wrapping at the pixel width. Above 8 bit the residuals are zigzagged and stored
    /// as every low byte followed by every high byte.
    /// </summary>
    private byte[] DecodeZstd()
    {
        var count = Width * Height;
        if (count <= 0)
        {
            throw new InvalidOperationException($"Invalid frame size {Width}x{Height}.");
        }

        var residuals = new byte[count * BytesPerPixel];
        int written;
        try
        {
            using var decompressor = new Decompressor();
            written = decompressor.Unwrap(Data, residuals);
        }
        catch (Exception e) when (e is ZstdException or ArgumentException)
        {
            throw new InvalidOperationException($"Not a zstd frame of {Width}x{Height} at {BitDepth} bit: {e.Message}", e);
        }

        if (written != residuals.Length)
        {
            throw new InvalidOperationException(
                $"zstd frame holds {written} bytes, {Width}x{Height} at {BitDepth} bit needs {residuals.Length}.");
        }

        if (BytesPerPixel == 1)
        {
            for (var i = Width; i < count; i++)
            {
                residuals[i] = (byte)(residuals[i] + residuals[i - Width]);
            }

            return residuals;
        }

        var pixels = new byte[count * 2];
        var values = new ushort[count];
        for (var i = 0; i < count; i++)
        {
            var z = residuals[i] | residuals[count + i] << 8;
            var d = (z >> 1) ^ -(z & 1);
            values[i] = (ushort)((i < Width ? 0 : values[i - Width]) + d);
            BinaryPrimitives.WriteUInt16LittleEndian(pixels.AsSpan(i * 2, 2), values[i]);
        }

        return pixels;
    }
}
