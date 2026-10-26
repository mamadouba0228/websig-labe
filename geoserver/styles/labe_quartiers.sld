<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>labe_quartiers</Name>
    <UserStyle>
      <Title>Quartiers</Title>
      <FeatureTypeStyle>
        <Rule>
          <PolygonSymbolizer>
            <Stroke><CssParameter name="stroke">#7048e8</CssParameter><CssParameter name="stroke-width">1.5</CssParameter></Stroke>
          </PolygonSymbolizer>
          <TextSymbolizer>
            <Label><ogc:PropertyName>nom</ogc:PropertyName></Label>
            <Font><CssParameter name="font-family">SansSerif</CssParameter><CssParameter name="font-size">11</CssParameter><CssParameter name="font-weight">bold</CssParameter></Font>
            <LabelPlacement><PointPlacement><AnchorPoint><AnchorPointX>0.5</AnchorPointX><AnchorPointY>0.5</AnchorPointY></AnchorPoint></PointPlacement></LabelPlacement>
            <Halo><Radius>2</Radius><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></Halo>
            <Fill><CssParameter name="fill">#5235b5</CssParameter></Fill>
          </TextSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
