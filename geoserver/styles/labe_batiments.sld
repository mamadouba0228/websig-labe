<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>labe_batiments</Name>
    <UserStyle>
      <Title>Bâti par nature</Title>
      <FeatureTypeStyle>
        <Rule>
          <Title>En construction</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Bâtiment en construction</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#f2c230</CssParameter><CssParameter name="fill-opacity">0.7</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#c99a00</CssParameter><CssParameter name="stroke-width">0.5</CssParameter></Stroke>
          </PolygonSymbolizer>
        </Rule>
        <Rule>
          <Title>Case / hutte</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Hute</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#a0785a</CssParameter><CssParameter name="fill-opacity">0.7</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#7a5a40</CssParameter><CssParameter name="stroke-width">0.5</CssParameter></Stroke>
          </PolygonSymbolizer>
        </Rule>
        <Rule>
          <Title>Scolaire</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Bâtiment scolaire</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#6f42c1</CssParameter><CssParameter name="fill-opacity">0.7</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#4b2a8a</CssParameter><CssParameter name="stroke-width">0.5</CssParameter></Stroke>
          </PolygonSymbolizer>
        </Rule>
        <Rule>
          <Title>Bâtiment</Title>
          <ElseFilter/>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#868e96</CssParameter><CssParameter name="fill-opacity">0.6</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#5c636a</CssParameter><CssParameter name="stroke-width">0.5</CssParameter></Stroke>
          </PolygonSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
