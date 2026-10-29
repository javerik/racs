using System.Runtime.CompilerServices;
using Racs.Dotnet.Models;

namespace Racs.Dotnet;

/// <summary>
/// A burst job on the server. The frames stay there until the job is deleted, or expire 10 min after it
/// finishes. Disposing the handle deletes the job:
/// <code>
/// await using var job = await cam.StartBurstAsync(20);
/// await foreach (var frame in job.ReadFramesAsync()) { ... }
/// </code>
/// </summary>
public sealed class BurstJob : IAsyncDisposable
{
    private static readonly TimeSpan DefaultPollInterval = TimeSpan.FromMilliseconds(100);

    // The first status that carried the frame geometry; it is the same for every frame.
    private BurstJobInfo? _geometry;

    internal BurstJob(Camera camera, Guid id)
    {
        Camera = camera;
        Id = id;
    }

    public Camera Camera { get; }

    public Guid Id { get; }

    private RacsClient Client => Camera.Client;

    public async Task<BurstJobInfo> GetInfoAsync(CancellationToken cancellationToken = default)
    {
        var info = await Client.GetGrabJobAsync(Camera.Id, Id, cancellationToken);
        if (info.Width is not null)
        {
            _geometry = info;
        }

        return info;
    }

    /// <summary>Every frame attempted so far, in capture order.</summary>
    public Task<IReadOnlyList<ImageEntryInfo>> ListImagesAsync(CancellationToken cancellationToken = default) =>
        Client.ListGrabJobImagesAsync(Camera.Id, Id, cancellationToken);

    /// <summary>The encoded bytes of frame <paramref name="index"/>.</summary>
    public Task<byte[]> GetImageAsync(int index, CancellationToken cancellationToken = default) =>
        Client.GetGrabJobImageAsync(Camera.Id, Id, index, cancellationToken);

    /// <summary>Frame <paramref name="index"/> with its geometry.</summary>
    public async Task<Frame> GetFrameAsync(int index, CancellationToken cancellationToken = default)
    {
        var data = await GetImageAsync(index, cancellationToken);
        var geometry = _geometry ?? await GetInfoAsync(cancellationToken);
        if (geometry.Width is not { } width || geometry.Height is not { } height)
        {
            throw new RacsException($"Burst job {Id} reports no frame geometry.");
        }

        return new Frame
        {
            Data = data,
            Width = width,
            Height = height,
            Format = geometry.Format,
            PixelFormat = geometry.PixelFormat ?? "Mono8",
            BitDepth = geometry.BitDepth ?? 8
        };
    }

    /// <summary>
    /// Waits until the job is completed or cancelled and returns its final status. Throws
    /// <see cref="BurstJobFailedException"/> if it failed.
    /// </summary>
    public async Task<BurstJobInfo> WaitAsync(TimeSpan? pollInterval = null, CancellationToken cancellationToken = default)
    {
        while (true)
        {
            var info = await GetInfoAsync(cancellationToken);
            if (info.Status.IsTerminal())
            {
                return info.Status == JobStatus.Failed ? throw new BurstJobFailedException(info) : info;
            }

            await Task.Delay(pollInterval ?? DefaultPollInterval, cancellationToken);
        }
    }

    /// <summary>
    /// Every captured frame in order, as soon as it is on the server; failed frames (only with
    /// <see cref="OnFailure.Skip"/>) are left out. Ends when the job is done, and throws
    /// <see cref="BurstJobFailedException"/> after the last frame if the job failed.
    /// </summary>
    public async IAsyncEnumerable<Frame> ReadFramesAsync(
        TimeSpan? pollInterval = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var nextIndex = 0;
        while (true)
        {
            // Status first: once it is terminal, the listing that follows is complete.
            var info = await GetInfoAsync(cancellationToken);
            foreach (var entry in await ListImagesAsync(cancellationToken))
            {
                if (entry.Index < nextIndex)
                {
                    continue;
                }

                nextIndex = entry.Index + 1;
                if (entry is ImageEntryOk)
                {
                    yield return await GetFrameAsync(entry.Index, cancellationToken);
                }
            }

            if (info.Status.IsTerminal())
            {
                if (info.Status == JobStatus.Failed)
                {
                    throw new BurstJobFailedException(info);
                }

                yield break;
            }

            await Task.Delay(pollInterval ?? DefaultPollInterval, cancellationToken);
        }
    }

    /// <summary>Cancels the job if it still runs, and drops it and its frames from the server.</summary>
    public Task DeleteAsync(CancellationToken cancellationToken = default) =>
        Client.DeleteGrabJobAsync(Camera.Id, Id, cancellationToken);

    public async ValueTask DisposeAsync()
    {
        try
        {
            await DeleteAsync();
        }
        catch (RacsNotFoundException)
        {
        }
    }

    public override string ToString() => $"BurstJob(device {Camera.Id}, {Id})";
}
