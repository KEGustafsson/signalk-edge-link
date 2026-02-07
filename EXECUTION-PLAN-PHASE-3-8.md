# Signal K Edge Link v2.0 - Phases 3-8 Execution Plans (Condensed)

**Note**: These are condensed execution plans. Full detailed plans available on request.

---

## Phase 3: Network Quality Metrics (Apr 5-25, 2026)

### Week 9: Metrics Publisher

**STEP 9.1**: Implement `lib/metrics-publisher.js`
```javascript
class MetricsPublisher {
  publishToSignalK(app, metrics) {
    app.handleMessage('vessels.self', {
      updates: [{
        values: [
          { path: 'networking.edgeLink.rtt', value: metrics.rtt },
          { path: 'networking.edgeLink.jitter', value: metrics.jitter },
          { path: 'networking.edgeLink.packetLoss', value: metrics.packetLoss },
          { path: 'networking.edgeLink.linkQuality', value: this.calculateQuality(metrics) }
          // ... 9 more paths
        ]
      }]
    });
  }
}
```

**STEP 9.2**: Calculate link quality score
- 40% packet loss weight
- 30% RTT weight
- 20% jitter weight
- 10% retransmit rate weight
- Scale: 0-100

**STEP 9.3**: Integrate into pipelines
- Client: Calculate from ACK timestamps, NAK counts
- Server: Calculate from received packet stats

### Week 10: Dashboard Updates

**STEP 10.1**: Add new metrics charts
- RTT over time (line chart)
- Packet loss heatmap
- Link quality gauge
- Retransmission rate

**STEP 10.2**: Update `/plugins/signalk-edge-link/metrics` endpoint

**STEP 10.3**: WebSocket for real-time updates

### Week 11: Observability

**STEP 11.1**: InfluxDB exporter (optional)
**STEP 11.2**: Prometheus endpoint
**STEP 11.3**: Alert system

**Deliverables**:
- 13 new Signal K paths
- Enhanced dashboard
- Monitoring integrations
- 30+ tests

**Tag**: `v2.0.0-alpha.3`

---

## Phase 4: Dynamic Congestion Control (Apr 26 - May 9, 2026)

### Week 12-13: AIMD Algorithm

**STEP 12.1**: Implement `lib/congestion.js`
```javascript
class CongestionControl {
  adjust() {
    if (this.avgLoss < 0.01 && this.avgRTT < this.targetRTT) {
      // Additive increase (decrease timer = increase rate)
      this.deltaTimer *= 0.95;
    } else if (this.avgLoss > 0.05 || this.avgRTT > this.targetRTT * 1.5) {
      // Multiplicative decrease
      this.deltaTimer *= 1.5;
    }
    
    // Apply limits and smoothing
    this.deltaTimer = this.clamp(this.deltaTimer, this.minTimer, this.maxTimer);
    
    return this.deltaTimer;
  }
}
```

**STEP 12.2**: Exponential moving average for metrics
**STEP 12.3**: Integrate with client pipeline
**STEP 12.4**: Manual override support

**STEP 13.1**: Test network transitions
- Good → Congested
- LTE → Satellite (high RTT)
- Packet loss spike recovery

**STEP 13.2**: Verify no oscillation

**Deliverables**:
- Adaptive delta timer
- No oscillation (<20% adjustment per interval)
- 25+ tests

**Tag**: `v2.0.0-alpha.4`

---

## Phase 5: Connection Bonding (May 10 - Jun 20, 2026)

### Week 14-15: Bonding Architecture

**STEP 14.1**: Implement `lib/bonding.js`
```javascript
class BondingManager {
  constructor(config) {
    this.links = {
      primary: new UDPSocket(config.primary),
      backup: new UDPSocket(config.backup)
    };
    this.activeLink = 'primary';
  }
  
  async checkHealth() {
    for (const [name, link] of Object.entries(this.links)) {
      const health = await this.measureLinkHealth(link);
      this.linkHealth[name] = health;
    }
    
    if (this.shouldFailover()) {
      await this.failover();
    }
  }
}
```

**STEP 14.2**: Link health monitoring per interface
**STEP 14.3**: Configuration schema for dual links

### Week 16-17: Main/Backup Mode

**STEP 16.1**: Primary link data transmission
**STEP 16.2**: Backup link heartbeat-only
**STEP 16.3**: Failover trigger logic
```javascript
shouldFailover() {
  const primary = this.linkHealth.primary;
  return (
    primary.rtt > this.config.rttThreshold ||
    primary.lossRate > this.config.lossThreshold ||
    primary.consecutiveFailures >= 3
  );
}
```

**STEP 16.4**: Failback after recovery (30s delay)

### Week 18-19: Integration & Testing

**STEP 18.1**: Per-link metrics to Signal K
**STEP 18.2**: Dashboard link status
**STEP 18.3**: Failover notification system

**STEP 19.1**: Failover testing scenarios
- Primary failure → backup takes over
- Primary recovery → failback
- Both links fail
- Simultaneous packet loss

**Deliverables**:
- Main/Backup bonding mode
- <2s failover time
- Independent link monitoring
- 60+ bonding tests

**Tag**: `v2.0.0-beta.1`

---

## Phase 6: Enhanced Monitoring (Jun 21 - Jul 11, 2026)

### Week 20: Extended Dashboard

**STEP 20.1**: Packet loss heatmap (temporal viz)
**STEP 20.2**: Per-path latency tracking
**STEP 20.3**: Retransmission rate chart
**STEP 20.4**: Active alerts panel

### Week 21: Diagnostic Tools

**STEP 21.1**: Packet capture export (`.pcap`)
```javascript
async exportPacketCapture(duration) {
  const packets = [];
  const captureHandler = (packet) => {
    packets.push({
      timestamp: Date.now(),
      data: packet,
      direction: 'tx' // or 'rx'
    });
  };
  
  // ... capture for duration ...
  
  return this.generatePcap(packets);
}
```

**STEP 21.2**: Live packet inspector (WebSocket)
**STEP 21.3**: Connection trace logging
**STEP 21.4**: Network simulation mode (for testing)

### Week 22: Production Observability

**STEP 22.1**: Alerting system with thresholds
**STEP 22.2**: InfluxDB integration guide
**STEP 22.3**: Pre-built Grafana dashboard
**STEP 22.4**: Prometheus exporter validation

**Deliverables**:
- Production diagnostics
- Alerts working
- Monitoring docs
- 20+ new tests

---

## Phase 7: Testing & Validation (Jul 12 - Aug 1, 2026)

### Week 23: Network Simulator Tests

**STEP 23.1**: Extend network simulator
- Link flapping
- Asymmetric loss (different rates per direction)
- Bandwidth throttling
- Jitter patterns

**STEP 23.2**: Test all 8 scenarios
1. Stable network (baseline)
2. High latency (600ms satellite)
3. Packet loss (5%, 10%, 20%)
4. Congestion (variable bandwidth)
5. Link failover
6. Dual-link bonding
7. Burst loss
8. Extended run (24h)

### Week 24: Performance Benchmarking

**STEP 24.1**: Bandwidth efficiency tests
**STEP 24.2**: CPU usage profiling
**STEP 24.3**: Memory leak testing (Valgrind)
**STEP 24.4**: Latency percentiles (p50, p95, p99)

### Week 25: Field Testing

**STEP 25.1**: Deploy to 3 test vessels
**STEP 25.2**: Real LTE/Starlink configurations
**STEP 25.3**: Collect metrics for 2 weeks
**STEP 25.4**: User acceptance testing
**STEP 25.5**: Bug triage and fixes

**Deliverables**:
- 350+ tests passing
- Performance targets met
- Field testing complete
- 50+ new integration tests

**Tag**: `v2.0.0-rc.1`

---

## Phase 8: Documentation & Release (Aug 2-15, 2026)

### Week 26: Documentation Sprint

**STEP 26.1**: Complete protocol specification
**STEP 26.2**: API reference updates
**STEP 26.3**: Migration guide (v1 → v2)
**STEP 26.4**: Configuration reference
**STEP 26.5**: Troubleshooting guide
**STEP 26.6**: Video tutorials

### Week 27: Release Engineering

**STEP 27.1**: Changelog generation
```bash
# Generate from git commits
git log v1.0.0..HEAD --pretty=format:"%s" | \
  grep -E "^(feat|fix|perf|docs)" | \
  sort > CHANGELOG.md
```

**STEP 27.2**: npm package preparation
```bash
npm run build
npm pack
# Test package installation
```

**STEP 27.3**: GitHub release creation
**STEP 27.4**: Docker images (optional)
**STEP 27.5**: Migration tools validation

### Stabilization (Aug 16 - Sep 12)

**STEP S.1**: Beta feedback incorporation
**STEP S.2**: Performance optimization
**STEP S.3**: Documentation polish
**STEP S.4**: Release candidate testing

### Production Release (Sep 13-20, 2026)

**STEP R.1**: Final testing checklist
```markdown
- [ ] All 350+ tests passing
- [ ] Test coverage >95%
- [ ] No ESLint warnings
- [ ] Documentation complete
- [ ] Migration guide tested
- [ ] Performance targets met
- [ ] Field testing successful
- [ ] Beta testers approved
```

**STEP R.2**: Version bump to 2.0.0
```bash
npm version 2.0.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v2.0.0"
git tag -a v2.0.0 -m "Release v2.0.0

Production release of Signal K Edge Link v2.0

Major Features:
- Versioned packet protocol with reliability
- ACK/NAK retransmission (99.9% delivery)
- Network quality metrics (13 new Signal K paths)
- Dynamic congestion control
- Connection bonding (LTE + Satellite failover)
- Enhanced monitoring and diagnostics

Performance:
- >99.9% delivery in 5% packet loss
- <2s failover time
- <10% latency overhead vs v1.0
- <5% CPU increase
- 350+ tests passing

Breaking Changes:
- Configuration schema extended
- Protocol v2 not compatible with v1 (auto-negotiation)

Migration:
See docs/migration/v1-to-v2.md"
```

**STEP R.3**: npm publish
```bash
npm publish
```

**STEP R.4**: GitHub release
**STEP R.5**: Announcements
- Signal K Slack
- GitHub Discussions
- npm registry
- Documentation site

**STEP R.6**: Monitor initial deployments

---

## Execution Checklist - All Phases

### Phase 1 ✅ (Complete)
- [x] Packet protocol
- [x] Sequence tracking
- [x] Pipeline integration
- [x] 75+ tests
- [x] v2.0.0-alpha.1

### Phase 2 ⏳
- [ ] Retransmit queue
- [ ] ACK/NAK protocol
- [ ] Reliability integration
- [ ] 100+ tests
- [ ] v2.0.0-alpha.2

### Phase 3 ⏳
- [ ] Metrics publisher
- [ ] Dashboard updates
- [ ] Observability
- [ ] 30+ tests
- [ ] v2.0.0-alpha.3

### Phase 4 ⏳
- [ ] Congestion control
- [ ] AIMD algorithm
- [ ] Network transitions
- [ ] 25+ tests
- [ ] v2.0.0-alpha.4

### Phase 5 ⏳
- [ ] Bonding architecture
- [ ] Main/Backup mode
- [ ] Failover testing
- [ ] 60+ tests
- [ ] v2.0.0-beta.1

### Phase 6 ⏳
- [ ] Extended dashboard
- [ ] Diagnostic tools
- [ ] Monitoring integrations
- [ ] 20+ tests

### Phase 7 ⏳
- [ ] Network simulation
- [ ] Performance benchmarks
- [ ] Field testing
- [ ] 50+ tests
- [ ] v2.0.0-rc.1

### Phase 8 ⏳
- [ ] Documentation
- [ ] Release engineering
- [ ] Stabilization
- [ ] v2.0.0 production

---

## Quick Reference Commands

### Run All Tests
```bash
npm test
```

### Run Phase Tests
```bash
npm test -- __tests__/v2/           # Unit tests
npm test -- test/integration/       # Integration tests
npm test -- test/benchmarks/        # Performance tests
```

### Check Coverage
```bash
npm run test:coverage
```

### Generate Changelog
```bash
git log v1.0.0..HEAD --oneline | grep -E "^[a-f0-9]+ (feat|fix|perf)"
```

### Performance Baseline
```bash
node test/benchmarks/phase-N-baseline.js
```

### Field Testing
```bash
# Deploy to test vessel
npm pack
scp signalk-edge-link-*.tgz vessel:/tmp/
ssh vessel "cd /home/pi/.signalk && npm install /tmp/signalk-edge-link-*.tgz"
```

---

## Success Criteria Summary

| Phase | Key Metric | Target | Status |
|-------|-----------|--------|--------|
| 1 | Packet tests | >95% coverage | ✅ |
| 2 | Delivery rate | >99.9% @ 5% loss | ⏳ |
| 3 | Metrics published | 13 paths | ⏳ |
| 4 | No oscillation | <20% adjustment | ⏳ |
| 5 | Failover time | <2s | ⏳ |
| 6 | Diagnostics | Complete | ⏳ |
| 7 | All tests | 350+ passing | ⏳ |
| 8 | Production | Released | ⏳ |

---

## Troubleshooting

### Tests Failing
```bash
# Run with verbose output
npm test -- --verbose

# Run single test file
npm test -- __tests__/v2/packet.test.js

# Debug specific test
node --inspect-brk node_modules/.bin/jest __tests__/v2/packet.test.js
```

### Performance Issues
```bash
# Profile CPU
node --prof test/benchmarks/reliability-overhead.js
node --prof-process isolate-*.log > profile.txt

# Check memory
node --inspect --expose-gc test/24h-stability.js
# Open chrome://inspect
```

### Network Issues
```bash
# Check UDP port
sudo lsof -i :5000

# Monitor packets
sudo tcpdump -i any udp port 5000 -w capture.pcap

# Test connectivity
nc -zvu 192.168.1.100 5000
```

---

**Total Development Timeline**: 28 weeks (Feb 7 - Sep 20, 2026)  
**Total Estimated Effort**: ~400 hours  
**Target Release**: v2.0.0 - September 2026

---

## Additional Resources

**Full Detailed Plans**: Available on request for each phase
- `EXECUTION-PLAN-PHASE-3-DETAILED.md`
- `EXECUTION-PLAN-PHASE-4-DETAILED.md`
- `EXECUTION-PLAN-PHASE-5-DETAILED.md`
- `EXECUTION-PLAN-PHASE-6-DETAILED.md`
- `EXECUTION-PLAN-PHASE-7-DETAILED.md`
- `EXECUTION-PLAN-PHASE-8-DETAILED.md`

**Planning Documents**:
- `signalk-edge-link-v2-plan.md` - Master plan
- `github-issues.md` - All 83 issues
- `README-PLANNING.md` - How to use everything

**Reference Implementation**:
- `packet.js` - Complete Phase 1 code
- `packet.test.js` - Test examples
- `network-simulator.js` - Testing framework

---

**End of Phases 3-8 Condensed Execution Plans**

*Request detailed plans for specific phases as needed.*
